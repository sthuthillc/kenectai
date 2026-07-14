/**
 * Product 2 — URL to Video.
 *
 * Input: a website URL. Output: a deterministic, seek-safe KENECT AI
 * composition (HTML) authored by Gemini from lightweight brand hints
 * scraped from the page, lint-gated with exactly one repair pass, ready to
 * hand to the existing render dispatch path (server.ts reuses
 * dispatchRender — no new render infra here).
 */

import type { GeminiClient } from "../gemini.js";
import { stripCodeFence } from "../gemini.js";
import type { HyperframeLintResult } from "@kenectai/lint/browser";
import { lintHyperframeHtml } from "@kenectai/lint/browser";

export interface BrandHints {
  title: string;
  description: string;
  themeColor: string | null;
  ogImage: string | null;
  headings: string[];
}

export interface WebsiteVideoResult {
  html: string;
  brandHints: BrandHints;
  lint: HyperframeLintResult;
  repaired: boolean;
}

export class CompositionLintError extends Error {
  constructor(
    message: string,
    readonly lint: HyperframeLintResult,
  ) {
    super(message);
  }
}

const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS_FOR_PROMPT = 20_000;

function matchOne(html: string, re: RegExp): string | null {
  return re.exec(html)?.[1]?.trim() || null;
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/** Best-effort brand extraction via regex — no DOM parser dependency. */
export function extractBrandHints(html: string, sourceUrl: string): BrandHints {
  const title =
    decodeEntities(matchOne(html, /<title[^>]*>([^<]*)<\/title>/i) || "") ||
    new URL(sourceUrl).hostname;
  const description = decodeEntities(
    matchOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
      matchOne(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i) ||
      "",
  );
  const themeColor = matchOne(
    html,
    /<meta[^>]+name=["']theme-color["'][^>]+content=["'](#[0-9a-fA-F]{3,8})["']/i,
  );
  const ogImage = matchOne(
    html,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i,
  );
  const headingMatches = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => decodeEntities((m[1] ?? "").replace(/<[^>]+>/g, "").trim()))
    .filter((h) => h.length > 0 && h.length < 160)
    .slice(0, 6);

  return {
    title: title.slice(0, 200),
    description: description.slice(0, 400),
    themeColor,
    ogImage,
    headings: headingMatches,
  };
}

export async function fetchPageHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "KenectAI-WebsiteVideo/1.0 (+https://kenectai.com)" },
    });
    if (!response.ok) {
      throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_FETCH_BYTES) {
      throw new Error(`page at ${url} exceeds the ${MAX_FETCH_BYTES} byte fetch limit`);
    }
    return Buffer.from(buffer).toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}

const COMPOSITION_CONTRACT = `You are authoring a KENECT AI video composition — a single self-contained HTML file. Follow this contract exactly:
- The root element carries data-composition-id, data-start="0", data-width="1920", data-height="1080", and data-duration="<total seconds>".
- EVERY timed element has class="clip" plus data-start, data-duration, and data-track-index (integers/decimals in seconds; track-index increments per overlapping layer).
- Load GSAP from this exact CDN tag: <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
- Build ONE gsap.timeline({ paused: true }), animate only transform/opacity/filter properties (x, y, scale, rotate, opacity — never letterSpacing, width, or other layout-reflowing properties), register it on window.__timelines["<composition-id>"], and call tl.seek(0) at the end.
- Every entrance tween must have a matching exit or a hard tl.set(...) at the clip's end boundary so seeking to any frame never leaves stale visibility state.
- Deterministic only: no Date.now(), no Math.random(), no network fetch, no external state.
- All CSS inline in a <style> tag. No external stylesheets besides Google Fonts <link> tags if needed.
- Output ONLY the raw HTML document — no markdown code fences, no commentary before or after.`;

function compositionPrompt(hints: BrandHints, durationS: number): string {
  return `${COMPOSITION_CONTRACT}

Write a ${durationS}-second promo composition for this website. Structure: a hero title reveal (2-4s), one or two feature/value beats built from the headings below (rest of the duration split evenly), and a closing beat with the site name as a call-to-action. Pick a cohesive color palette and font pairing that fits the brand (use the theme color below as a strong hint if present); keep type large and legible at video scale.

Brand hints scraped from the page:
- Site / title: ${hints.title}
- Description: ${hints.description || "(none found)"}
- Theme color: ${hints.themeColor || "(none found — choose one)"}
- Headings found on page: ${hints.headings.length ? hints.headings.join(" | ") : "(none found)"}`;
}

function repairPrompt(html: string, lint: HyperframeLintResult): string {
  const issues = lint.findings
    .filter((f) => f.severity === "error")
    .map(
      (f) =>
        `- [${f.code}]${f.elementId ? ` on #${f.elementId}` : ""}: ${f.message}${f.fixHint ? ` Fix: ${f.fixHint}` : ""}`,
    )
    .join("\n");
  return `${COMPOSITION_CONTRACT}

The following KENECT AI composition has lint errors that must be fixed. Return the FULL corrected HTML document (not a diff), preserving everything else about the design and timing intent. Fix ONLY these issues:
${issues}

Composition to fix:
---
${html}
---`;
}

export async function generateWebsiteComposition(
  gemini: GeminiClient,
  sourceUrl: string,
  durationS: number,
): Promise<WebsiteVideoResult> {
  const pageHtml = await fetchPageHtml(sourceUrl);
  const brandHints = extractBrandHints(pageHtml.slice(0, MAX_HTML_CHARS_FOR_PROMPT), sourceUrl);

  const draft = stripCodeFence(
    await gemini.generateText(compositionPrompt(brandHints, durationS), {
      temperature: 0.6,
      maxOutputTokens: 8192,
      thinkingLevel: "high",
    }),
  );

  const firstLint = await lintHyperframeHtml(draft);
  if (firstLint.ok) {
    return { html: draft, brandHints, lint: firstLint, repaired: false };
  }

  const repaired = stripCodeFence(
    await gemini.generateText(repairPrompt(draft, firstLint), {
      temperature: 0.3,
      maxOutputTokens: 8192,
      thinkingLevel: "high",
    }),
  );
  const secondLint = await lintHyperframeHtml(repaired);
  if (secondLint.ok) {
    return { html: repaired, brandHints, lint: secondLint, repaired: true };
  }

  throw new CompositionLintError(
    `generated composition failed lint after repair (${secondLint.errorCount} error(s)): ${secondLint.findings
      .filter((f) => f.severity === "error")
      .map((f) => f.message)
      .join("; ")}`,
    secondLint,
  );
}
