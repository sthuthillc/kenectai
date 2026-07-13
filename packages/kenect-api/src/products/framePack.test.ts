import { afterEach, describe, expect, it, vi } from "vitest";
import { lintHyperframeHtml } from "@kenectai/lint/browser";
import { GeminiClient, GeminiError } from "../gemini.js";
import {
  buildFrameShowcaseHtml,
  buildReadmeHtml,
  generateFrameMd,
  generateFramePack,
  generateFrameTokens,
  type FrameTokens,
} from "./framePack.js";

const SAMPLE_TOKENS: FrameTokens = {
  productName: "MirrorFit AI",
  voice: "Maximalist neobrutalist — thick borders, hard shadows, candy accents",
  colors: [
    { name: "ink", hex: "#0E0E0E", role: "ink", usage: "primary type" },
    { name: "paper", hex: "#F4EEE4", role: "paper", usage: "background" },
    { name: "flare", hex: "#E63946", role: "accent", usage: "the single accent" },
    { name: "saffron", hex: "#E5A100", role: "secondary", usage: "used once" },
    { name: "jade", hex: "#1F5F4A", role: "affirm", usage: "verify state" },
    { name: "steel", hex: "#7A756C", role: "neutral", usage: "hairlines" },
  ],
  typography: { display: "Fraunces", text: "Inter", mono: "JetBrains Mono" },
};

function geminiOkResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildFrameShowcaseHtml", () => {
  it("produces a composition that passes the HyperFrame lint gate", async () => {
    const html = buildFrameShowcaseHtml(SAMPLE_TOKENS);
    const result = await lintHyperframeHtml(html);
    expect(result.errorCount).toBe(0);
  });

  it("embeds the product name and voice", () => {
    const html = buildFrameShowcaseHtml(SAMPLE_TOKENS);
    expect(html).toContain("MirrorFit AI");
    expect(html).toContain("Maximalist neobrutalist");
  });

  it("registers the timeline under the composition id", () => {
    const html = buildFrameShowcaseHtml(SAMPLE_TOKENS);
    expect(html).toContain('data-composition-id="frame-showcase"');
    expect(html).toContain('window.__timelines["frame-showcase"]');
  });

  it("escapes HTML-unsafe characters in the product name", () => {
    const html = buildFrameShowcaseHtml({ ...SAMPLE_TOKENS, productName: "A & B <script>" });
    expect(html).not.toContain("<script>A");
    expect(html).toContain("A &amp; B &lt;script&gt;");
  });
});

describe("buildReadmeHtml", () => {
  it("lists all three pack files and the product name", () => {
    const html = buildReadmeHtml(SAMPLE_TOKENS);
    expect(html).toContain("MirrorFit AI");
    expect(html).toContain("FRAME.md");
    expect(html).toContain("frame-showcase.html");
    expect(html).toContain("README.html");
  });
});

describe("generateFrameTokens", () => {
  it("returns parsed tokens on a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiOkResponse(JSON.stringify(SAMPLE_TOKENS))),
    );
    const gemini = new GeminiClient({ apiKey: "k" });
    await expect(generateFrameTokens(gemini, "some brand doc")).resolves.toEqual(SAMPLE_TOKENS);
  });

  it("rejects when Gemini returns fewer than 6 colors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiOkResponse(
          JSON.stringify({ ...SAMPLE_TOKENS, colors: SAMPLE_TOKENS.colors.slice(0, 2) }),
        ),
      ),
    );
    const gemini = new GeminiClient({ apiKey: "k" });
    await expect(generateFrameTokens(gemini, "doc")).rejects.toThrow(/incomplete/);
  });
});

describe("generateFrameMd", () => {
  it("strips an accidental code fence from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => geminiOkResponse('```markdown\ncolors:\n  ink: "#000"\n```')),
    );
    const gemini = new GeminiClient({ apiKey: "k" });
    await expect(generateFrameMd(gemini, SAMPLE_TOKENS, "doc")).resolves.toBe(
      'colors:\n  ink: "#000"',
    );
  });
});

describe("generateFramePack", () => {
  it("orchestrates tokens -> FRAME.md -> deterministic showcase + readme", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => geminiOkResponse(JSON.stringify(SAMPLE_TOKENS)))
      .mockImplementationOnce(async () =>
        geminiOkResponse('# FRAME.md\ncolors:\n  ink: "#0E0E0E"'),
      );
    vi.stubGlobal("fetch", fetchMock);
    const gemini = new GeminiClient({ apiKey: "k" });

    const result = await generateFramePack(gemini, "MirrorFit AI is an AI fashion platform...");

    expect(result.tokens.productName).toBe("MirrorFit AI");
    expect(result.frameMd).toContain("FRAME.md");
    expect(result.frameShowcaseHtml).toContain("MirrorFit AI");
    expect(result.readmeHtml).toContain("FRAME.md");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const showcaseLint = await lintHyperframeHtml(result.frameShowcaseHtml);
    expect(showcaseLint.errorCount).toBe(0);
  });

  it("propagates a GeminiError from the tokens call without a second call", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const gemini = new GeminiClient({ apiKey: "k" });
    await expect(generateFramePack(gemini, "doc")).rejects.toThrow(GeminiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
