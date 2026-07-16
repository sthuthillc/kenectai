import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiClient, GeminiError, stripCodeFence } from "./gemini.js";

function geminiOkResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stripCodeFence", () => {
  it("strips a fenced block with a language tag", () => {
    expect(stripCodeFence("```html\n<div>hi</div>\n```")).toBe("<div>hi</div>");
  });

  it("strips a fenced block with no language tag", () => {
    expect(stripCodeFence("```\nplain\n```")).toBe("plain");
  });

  it("leaves unfenced text untouched", () => {
    expect(stripCodeFence("  <div>hi</div>  ")).toBe("<div>hi</div>");
  });
});

describe("GeminiClient", () => {
  it("throws GeminiError when constructed without an API key", () => {
    expect(() => new GeminiClient({ apiKey: "" })).toThrow(GeminiError);
  });

  it("generateText returns the concatenated candidate text", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse("hello world"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateText("prompt")).resolves.toBe("hello world");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("generativelanguage.googleapis.com");
    expect(String(url)).toContain("gemini-3-flash-preview");
  });

  it("uses the configured model in the request URL", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key", model: "gemini-2.5-pro" });
    await client.generateText("prompt");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("gemini-2.5-pro");
  });

  it("omits thinkingConfig by default", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await client.generateText("prompt");
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(sentBody.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("sends thinkingConfig.thinkingLevel when requested", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await client.generateText("prompt", { thinkingLevel: "high" });
    const sentBody = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(sentBody.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("generateJson parses the candidate text as JSON", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse('{"a":1,"b":"two"}'));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateJson<{ a: number; b: string }>("prompt")).resolves.toEqual({
      a: 1,
      b: "two",
    });
  });

  it("generateJson throws GeminiError on invalid JSON output", async () => {
    const fetchMock = vi.fn(async () => geminiOkResponse("not json"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateJson("prompt")).rejects.toThrow(GeminiError);
  });

  it("throws GeminiError on a non-OK HTTP response", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateText("prompt")).rejects.toThrow(GeminiError);
  });

  it("throws GeminiError when the prompt is blocked", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateText("prompt")).rejects.toThrow(/blocked/);
  });

  it("throws GeminiError when there are no candidates", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GeminiClient({ apiKey: "test-key" });
    await expect(client.generateText("prompt")).rejects.toThrow(GeminiError);
  });
});
