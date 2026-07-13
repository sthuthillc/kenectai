import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, GeminiError } from "../gemini.js";
import {
  CompositionLintError,
  extractBrandHints,
  fetchPageHtml,
  generateWebsiteComposition,
} from "./websiteVideo.js";

const SAMPLE_PAGE_HTML = `<!doctype html>
<html>
<head>
  <title>Acme Rockets — Faster Than Sound</title>
  <meta name="description" content="We build rockets that get there yesterday.">
  <meta name="theme-color" content="#FF6600">
  <meta property="og:image" content="https://acme.example/hero.png">
</head>
<body>
  <h1>Faster than sound</h1>
  <h2>Built for engineers</h2>
  <h2>Trusted by nobody yet</h2>
</body>
</html>`;

const VALID_COMPOSITION = `<!doctype html>
<html>
<head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
</head>
<body>
<div id="root" data-composition-id="homepage" data-start="0" data-width="1920" data-height="1080" data-duration="6">
  <section id="hero" class="clip" data-start="0" data-duration="6" data-track-index="0">
    <h1 id="title">Acme Rockets</h1>
  </section>
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { opacity: 0, y: 40, duration: 0.6 }, 0.2);
  tl.to("#title", { opacity: 0, duration: 0.4 }, 5.4);
  tl.seek(0);
  window.__timelines["homepage"] = tl;
</script>
</body>
</html>`;

// Missing the window.__timelines registration -> triggers missing_timeline_registry.
const BROKEN_COMPOSITION = VALID_COMPOSITION.replace('window.__timelines["homepage"] = tl;', "");

function geminiOkResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }),
    { status: 200 },
  );
}

function routedFetch(pageHtml: string, ...geminiTexts: string[]): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      const text = geminiTexts[call] ?? geminiTexts[geminiTexts.length - 1]!;
      call += 1;
      return geminiOkResponse(text);
    }
    return new Response(pageHtml, { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractBrandHints", () => {
  it("extracts title, description, theme color, og:image, and headings", () => {
    const hints = extractBrandHints(SAMPLE_PAGE_HTML, "https://acme.example/");
    expect(hints.title).toBe("Acme Rockets — Faster Than Sound");
    expect(hints.description).toBe("We build rockets that get there yesterday.");
    expect(hints.themeColor).toBe("#FF6600");
    expect(hints.ogImage).toBe("https://acme.example/hero.png");
    expect(hints.headings).toEqual([
      "Faster than sound",
      "Built for engineers",
      "Trusted by nobody yet",
    ]);
  });

  it("falls back to the hostname when no <title> is present", () => {
    const hints = extractBrandHints(
      "<html><body>no title here</body></html>",
      "https://acme.example/x",
    );
    expect(hints.title).toBe("acme.example");
    expect(hints.themeColor).toBeNull();
    expect(hints.ogImage).toBeNull();
    expect(hints.headings).toEqual([]);
  });
});

describe("fetchPageHtml", () => {
  it("returns the response body as text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>hi</html>", { status: 200 })),
    );
    await expect(fetchPageHtml("https://acme.example/")).resolves.toBe("<html>hi</html>");
  });

  it("throws on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(fetchPageHtml("https://acme.example/missing")).rejects.toThrow(/404/);
  });

  it("throws when the page exceeds the fetch size limit", async () => {
    const huge = "x".repeat(6 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(huge, { status: 200 })),
    );
    await expect(fetchPageHtml("https://acme.example/huge")).rejects.toThrow(/exceeds/);
  });
});

describe("generateWebsiteComposition", () => {
  it("returns the draft unmodified when it lints clean on the first pass", async () => {
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, VALID_COMPOSITION));
    const gemini = new GeminiClient({ apiKey: "k" });

    const result = await generateWebsiteComposition(gemini, "https://acme.example/", 6);

    expect(result.repaired).toBe(false);
    expect(result.lint.ok).toBe(true);
    expect(result.brandHints.title).toBe("Acme Rockets — Faster Than Sound");
    expect(result.html).toContain("Acme Rockets");
  });

  it("repairs a broken draft and returns the fixed composition", async () => {
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, BROKEN_COMPOSITION, VALID_COMPOSITION));
    const gemini = new GeminiClient({ apiKey: "k" });

    const result = await generateWebsiteComposition(gemini, "https://acme.example/", 6);

    expect(result.repaired).toBe(true);
    expect(result.lint.ok).toBe(true);
  });

  it("throws CompositionLintError when the repair pass still fails", async () => {
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, BROKEN_COMPOSITION, BROKEN_COMPOSITION));
    const gemini = new GeminiClient({ apiKey: "k" });

    const err = await generateWebsiteComposition(gemini, "https://acme.example/", 6).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(CompositionLintError);
    expect(err.lint.errorCount).toBeGreaterThan(0);
  });

  it("propagates a GeminiError from the composition-authoring call", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("generativelanguage.googleapis.com")) {
          call += 1;
          return new Response("service unavailable", { status: 503 });
        }
        return new Response(SAMPLE_PAGE_HTML, { status: 200 });
      }),
    );
    const gemini = new GeminiClient({ apiKey: "k" });
    await expect(generateWebsiteComposition(gemini, "https://acme.example/", 6)).rejects.toThrow(
      GeminiError,
    );
    expect(call).toBe(1);
  });
});
