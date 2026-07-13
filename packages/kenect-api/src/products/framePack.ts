/**
 * Product 1 — frame-pack generator.
 *
 * Input: any brand-adjacent document (design.md, an SEO strategy, notes —
 * whatever the customer has). Output: a 3-file pack —
 *   FRAME.md            — a video-first design-token spec (Gemini-authored)
 *   frame-showcase.html — a real, lint-passable KENECT AI composition that
 *                          demonstrates the tokens (built deterministically
 *                          from the same tokens JSON, not parsed back out of
 *                          the markdown — keeps this half of the pipeline
 *                          reliable and testable without an LLM call)
 *   README.html          — a manifest page describing the pack
 *
 * Doctrine carried into the prompt: "Atoms are sacred, composition is free,
 * numbers come from the script" — colors/type/spacing are fixed tokens;
 * layout and pacing are free to vary per composition.
 */

import type { GeminiClient } from "../gemini.js";
import { stripCodeFence } from "../gemini.js";

export interface FrameTokenColor {
  name: string;
  hex: string;
  role: string;
  usage: string;
}

export interface FrameTokens {
  productName: string;
  voice: string;
  colors: FrameTokenColor[];
  typography: {
    display: string;
    text: string;
    mono: string;
  };
}

export interface FramePackResult {
  tokens: FrameTokens;
  frameMd: string;
  frameShowcaseHtml: string;
  readmeHtml: string;
}

const MAX_SOURCE_CHARS = 60_000;

function tokensPrompt(sourceText: string): string {
  return `You are a brand strategist deriving a VIDEO design-token system from a company's own document.
The document may be a design brief, an SEO strategy, product notes, or anything else brand-adjacent —
derive tokens from whatever signal is present (tone of voice, target customer, product category, any
explicit colors/fonts mentioned). If no visual details are given, invent a coherent, distinctive system
that fits the brand's category and voice.

Return STRICT JSON matching exactly this shape (no markdown, no commentary):
{
  "productName": string,           // best-guess product/company name from the document
  "voice": string,                 // one short phrase describing the visual voice, e.g. "Maximalist neobrutalist — thick borders, hard shadows, candy accents"
  "colors": [                      // exactly 6 entries, in this role order
    { "name": string, "hex": "#RRGGBB", "role": "ink",        "usage": string },  // primary near-black or near-white ground/type
    { "name": string, "hex": "#RRGGBB", "role": "paper",      "usage": string },  // primary background surface
    { "name": string, "hex": "#RRGGBB", "role": "accent",     "usage": string },  // the ONE signature accent — used sparingly
    { "name": string, "hex": "#RRGGBB", "role": "secondary",  "usage": string },  // a secondary accent, used once or twice
    { "name": string, "hex": "#RRGGBB", "role": "affirm",     "usage": string },  // positive/success/verify state color
    { "name": string, "hex": "#RRGGBB", "role": "neutral",    "usage": string }   // mid-gray for hairlines/metadata
  ],
  "typography": {
    "display": string,  // a real, web-safe-or-Google-Fonts display/serif family name for headlines
    "text": string,      // a real body sans family name
    "mono": string        // a real monospace family name for chips/labels/captions
  }
}

Source document (truncated to ${MAX_SOURCE_CHARS} chars):
---
${sourceText.slice(0, MAX_SOURCE_CHARS)}
---`;
}

function frameMdPrompt(tokens: FrameTokens, sourceText: string): string {
  return `You are writing FRAME.md — a video-first companion to a design.md, for the product "${tokens.productName}".
Doctrine, keep it at the top verbatim as a comment header: "Atoms are sacred · composition is free · numbers come from the script."

Use EXACTLY these tokens (do not invent new colors or font families — you may add derived variants like rgba/opacity steps):
${JSON.stringify(tokens, null, 2)}

Write a complete FRAME.md in this structure (YAML-ish, matching the real HyperFrames/KENECT AI frame.md format):
1. Frontmatter comment block: title line, doctrine line.
2. \`colors:\` block — one entry per token color plus 1-2 sensible derived rgba variants (e.g. "${tokens.colors[0]?.name ?? "ink"}-60").
3. \`typography:\` block with TWO ramps:
   - \`reading:\` (h1/h2/h3/body/caption) in web px + a matching cqw-equivalent comment, using the display/text/mono families.
   - \`hero:\` (wordmark-mega, display-hero, display-large, section-head, stat-mega, body-hero, eyebrow-hero, tag-mono, colophon) sized in cqw against a 1920 frame, using fontVariantNumeric: tabular-nums on the stat sizes.
   Include a \`legibility-floor\` note.
4. \`rounded:\` scale (sharp/soft/pill).
5. \`spacing:\` numeric scale 0-8 in px, plus frame-pad/frame-safe/frame-gutter in vw/cqw.
6. \`components:\` at least 10 named component specs (e.g. wordmark, headline-serif, kicker, cta-primary, stat-mega-block, ledger-row, category-tag, hairline, mirror-tile, colophon-line) — each referencing tokens via "{colors.x}" / "{typography.hero.x}" interpolation syntax, not literal values.

Ground the component choices and voice in this source document (for context only — do not quote it verbatim):
---
${sourceText.slice(0, 4000)}
---

Output ONLY the FRAME.md markdown content. No code fences, no commentary before or after.`;
}

export async function generateFrameTokens(
  gemini: GeminiClient,
  sourceText: string,
): Promise<FrameTokens> {
  const tokens = await gemini.generateJson<FrameTokens>(tokensPrompt(sourceText), {
    temperature: 0.6,
    maxOutputTokens: 2048,
  });
  if (!tokens.productName || !Array.isArray(tokens.colors) || tokens.colors.length < 6) {
    throw new Error("Gemini returned incomplete frame tokens (missing productName or colors)");
  }
  return tokens;
}

export async function generateFrameMd(
  gemini: GeminiClient,
  tokens: FrameTokens,
  sourceText: string,
): Promise<string> {
  const text = await gemini.generateText(frameMdPrompt(tokens, sourceText), {
    temperature: 0.5,
    maxOutputTokens: 6000,
  });
  return stripCodeFence(text);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Builds the showcase deterministically from the tokens JSON (not parsed
 * back out of the LLM-authored markdown) so this half of the pipeline is
 * reliable, fast, and independently testable/lintable.
 */
export function buildFrameShowcaseHtml(tokens: FrameTokens): string {
  const ink = tokens.colors.find((c) => c.role === "ink")?.hex ?? "#0E0E0E";
  const paper = tokens.colors.find((c) => c.role === "paper")?.hex ?? "#F4EEE4";
  const accent = tokens.colors.find((c) => c.role === "accent")?.hex ?? "#E63946";
  const secondary = tokens.colors.find((c) => c.role === "secondary")?.hex ?? "#1F5F4A";
  const affirm = tokens.colors.find((c) => c.role === "affirm")?.hex ?? "#1F5F4A";
  const neutral = tokens.colors.find((c) => c.role === "neutral")?.hex ?? "#7A756C";
  const display = tokens.typography.display || "Georgia, serif";
  const text = tokens.typography.text || "-apple-system, sans-serif";
  const mono = tokens.typography.mono || "ui-monospace, monospace";
  const fontQuery = [tokens.typography.display, tokens.typography.text, tokens.typography.mono]
    .filter(Boolean)
    .map((f) => `family=${encodeURIComponent(f.split(",")[0]!.trim())}:wght@400;500;600;700`)
    .join("&");
  const name = escapeHtml(tokens.productName || "Untitled");
  const voice = escapeHtml(tokens.voice || "");
  const swatches = tokens.colors
    .map(
      (c) => `
      <div class="swatch" style="background:${c.hex}">
        <span class="swatch-label" style="color:${isLight(c.hex) ? ink : paper}">${escapeHtml(c.role)}<br>${escapeHtml(c.hex)}</span>
      </div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1920, height=1080" />
  <title>${name} — frame-showcase</title>
  ${fontQuery ? `<link href="https://fonts.googleapis.com/css2?${fontQuery}&display=swap" rel="stylesheet" />` : ""}
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: ${paper}; }
    #root {
      position: relative; width: 1920px; height: 1080px; overflow: hidden;
      background: ${paper}; color: ${ink}; font-family: ${text};
    }
    .clip { position: absolute; inset: 0; overflow: hidden; }
    .inner { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 48px; }
    #cover-inner h1 { font-family: ${display}; font-size: 150px; font-weight: 600; letter-spacing: -0.02em; color: ${ink}; }
    #cover-inner .voice { font-family: ${mono}; font-size: 24px; letter-spacing: 0.08em; text-transform: uppercase; color: ${neutral}; }
    #colors-inner { flex-direction: row; gap: 0; }
    .swatch { width: 320px; height: 1080px; display: flex; align-items: flex-end; padding: 48px; }
    .swatch-label { font-family: ${mono}; font-size: 20px; letter-spacing: 0.06em; text-transform: uppercase; line-height: 1.4; }
    #type-inner h2 { font-family: ${display}; font-size: 96px; font-weight: 600; color: ${ink}; }
    #type-inner p { font-family: ${text}; font-size: 32px; color: ${ink}; max-width: 900px; text-align: center; line-height: 1.5; }
    #component-inner { gap: 32px; }
    .cta { font-family: ${mono}; font-size: 22px; letter-spacing: 0.1em; text-transform: uppercase; padding: 20px 48px; border-radius: 999px; background: ${accent}; color: ${paper}; }
    .stat { font-family: ${display}; font-size: 220px; font-weight: 600; color: ${ink}; line-height: 0.9; }
    .ledger { display: flex; gap: 24px; align-items: center; }
    .dot { width: 14px; height: 14px; border-radius: 50%; background: ${affirm}; }
    .tag { font-family: ${mono}; font-size: 20px; letter-spacing: 0.1em; text-transform: uppercase; padding: 8px 20px; border-radius: 6px; background: ${secondary}; color: ${paper}; }
  </style>
</head>
<body>
  <div id="root" data-composition-id="frame-showcase" data-start="0" data-width="1920" data-height="1080" data-duration="12">
    <section id="beat-cover" class="clip" data-start="0" data-duration="4" data-track-index="1">
      <div id="cover-inner" class="inner">
        <h1 id="cover-title">${name}</h1>
        <div class="voice">${voice}</div>
      </div>
    </section>
    <section id="beat-colors" class="clip" data-start="4" data-duration="3.2" data-track-index="2">
      <div id="colors-inner" class="inner">
        ${swatches}
      </div>
    </section>
    <section id="beat-type" class="clip" data-start="7.2" data-duration="2.6" data-track-index="3">
      <div id="type-inner" class="inner">
        <h2>Aa Bb Cc</h2>
        <p>${escapeHtml(display)} for display, ${escapeHtml(text)} for reading, ${escapeHtml(mono)} for chips and captions.</p>
      </div>
    </section>
    <section id="beat-component" class="clip" data-start="9.8" data-duration="2.2" data-track-index="4">
      <div id="component-inner" class="inner">
        <div class="stat" id="stat-value">128%</div>
        <div class="ledger"><span class="dot"></span><span class="tag">verified</span><span class="cta">Get started</span></div>
      </div>
    </section>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    tl.from("#cover-title", { y: 60, opacity: 0, duration: 0.7, ease: "power3.out" }, 0.2);
    tl.from("#cover-inner .voice", { opacity: 0, duration: 0.5 }, 0.7);
    tl.to("#cover-inner", { opacity: 0, duration: 0.4, ease: "power2.in" }, 3.6);
    tl.set("#cover-inner", { opacity: 0 }, 4.0);
    tl.from("#colors-inner .swatch", { y: 40, opacity: 0, duration: 0.5, stagger: 0.08, ease: "power2.out" }, 4.15);
    tl.to("#colors-inner", { opacity: 0, duration: 0.4, ease: "power2.in" }, 6.9);
    tl.set("#colors-inner", { opacity: 0 }, 7.2);
    tl.from("#type-inner h2", { scale: 0.85, opacity: 0, duration: 0.5, ease: "back.out(1.6)" }, 7.35);
    tl.from("#type-inner p", { opacity: 0, y: 20, duration: 0.5 }, 7.65);
    tl.to("#type-inner", { opacity: 0, duration: 0.4, ease: "power2.in" }, 9.6);
    tl.set("#type-inner", { opacity: 0 }, 9.8);
    tl.from("#component-inner .stat", { scale: 0.9, opacity: 0, duration: 0.5, ease: "back.out(1.5)" }, 9.95);
    tl.from("#component-inner .ledger > *", { y: 20, opacity: 0, duration: 0.4, stagger: 0.08 }, 10.3);
    tl.seek(0);
    window.__timelines["frame-showcase"] = tl;
  </script>
</body>
</html>
`;
}

export function buildReadmeHtml(tokens: FrameTokens): string {
  const name = escapeHtml(tokens.productName || "Untitled");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${name} — Frame Pack</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.6; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; }
    p, li { font-size: 15px; }
    code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; background: #f4f4f5; padding: 1px 6px; border-radius: 4px; }
    ul { padding-left: 0; list-style: none; }
    li { margin: 16px 0; padding: 14px 16px; border: 1px solid #e5e5e7; border-radius: 8px; }
    li strong { display: block; margin-bottom: 4px; }
    .pill { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em; }
    .pill-include { background: #e6f4ea; color: #137333; }
    .pill-preview { background: #fef7e0; color: #8a6300; }
  </style>
</head>
<body>
  <h1>${name} — Frame Pack</h1>
  <p>Generated by Kenect AI. A video-first design-token system derived from your document, plus a live storyboard preview.</p>
  <h2>Files</h2>
  <ul>
    <li><span class="pill pill-include">include</span><strong><code>FRAME.md</code></strong>Design tokens for video: colors, dual typography ramps (reading + hero cqw), spacing, and named components. Drop this into a Kenect AI project.</li>
    <li><span class="pill pill-preview">preview</span><strong><code>frame-showcase.html</code></strong>A real, renderable Kenect AI composition demonstrating the tokens in motion. Open directly in a browser, or run <code>kenectai render</code> on it.</li>
    <li><span class="pill pill-preview">preview</span><strong><code>README.html</code></strong>This file.</li>
  </ul>
</body>
</html>
`;
}

function isLight(hex: string): boolean {
  const h = hex.replace("#", "");
  if (h.length !== 6) return false;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

export async function generateFramePack(
  gemini: GeminiClient,
  sourceText: string,
): Promise<FramePackResult> {
  const tokens = await generateFrameTokens(gemini, sourceText);
  const frameMd = await generateFrameMd(gemini, tokens, sourceText);
  const frameShowcaseHtml = buildFrameShowcaseHtml(tokens);
  const readmeHtml = buildReadmeHtml(tokens);
  return { tokens, frameMd, frameShowcaseHtml, readmeHtml };
}
