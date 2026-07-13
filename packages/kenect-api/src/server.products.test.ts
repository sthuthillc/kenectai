/**
 * Route-level tests for the two Gemini-backed product endpoints, driven
 * through Hono's `app.request()` against an in-memory GCS mock and a
 * stubbed `fetch` (routes Gemini calls one way, the render SDK is mocked
 * separately — same pattern as oauthServer.test.ts).
 */

import type { Storage } from "@google-cloud/storage";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKenectApiApp, type KenectApiEnv } from "./server.js";

const renderToCloudRunMock = vi.fn(async () => ({
  renderId: "hfr_test123",
  executionName: "projects/test/executions/exec-1",
  outputGcsUri: "gs://test-bucket/renders/hfr_test123/output.mp4",
  projectGcsUri: "gs://test-bucket/renders/hfr_test123/project.zip",
}));

vi.mock("@kenectai/gcp-cloud-run/sdk", () => ({
  renderToCloudRun: (...args: unknown[]) => renderToCloudRunMock(...args),
  getRenderProgress: () => {
    throw new Error("getRenderProgress is not used by product tests");
  },
}));

// --- in-memory GCS mock (adds getSignedUrl/getMetadata over the oauth suite's) ---

class MemFile {
  constructor(
    private readonly files: Map<string, Buffer>,
    private readonly key: string,
  ) {}

  async save(contents: string | Buffer): Promise<void> {
    this.files.set(this.key, Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"));
  }

  async exists(): Promise<[boolean]> {
    return [this.files.has(this.key)];
  }

  async download(): Promise<[Buffer]> {
    const value = this.files.get(this.key);
    if (value === undefined) throw new Error(`No such object: ${this.key}`);
    return [value];
  }

  async delete(): Promise<void> {
    this.files.delete(this.key);
  }

  async getMetadata(): Promise<[{ size: number; contentType: string }]> {
    const value = this.files.get(this.key);
    return [{ size: value?.byteLength ?? 0, contentType: "application/octet-stream" }];
  }

  async getSignedUrl(): Promise<[string]> {
    return [`https://signed.test/${this.key}`];
  }
}

class MemBucket {
  constructor(private readonly files: Map<string, Buffer>) {}

  file(key: string): MemFile {
    return new MemFile(this.files, key);
  }

  async getFiles(opts: { prefix?: string; maxResults?: number }): Promise<[MemFile[]]> {
    const keys = [...this.files.keys()]
      .filter((key) => key.startsWith(opts.prefix ?? ""))
      .slice(0, opts.maxResults);
    return [keys.map((key) => new MemFile(this.files, key))];
  }
}

class MemStorage {
  private readonly files = new Map<string, Buffer>();

  bucket(_name: string): MemBucket {
    return new MemBucket(this.files);
  }
}

const testEnv: KenectApiEnv = {
  apiBaseUrl: "https://api.test",
  appBaseUrl: "https://app.test",
  uploadBucket: "test-bucket",
  renderBucket: "test-bucket",
  projectId: "test-project",
  renderLocation: "us-central1",
  renderWorkflowId: "test-workflow",
  renderServiceUrl: "https://render.test",
  apiKeys: ["test-api-key"],
  jwtSecret: "test-secret",
  geminiApiKey: "test-gemini-key",
  geminiModel: "gemini-2.5-flash",
};

function makeApp(env: KenectApiEnv = testEnv): Hono {
  const storage = new MemStorage() as unknown as Storage;
  return createKenectApiApp({ env, storage });
}

function authed(body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-api-key" },
    body: JSON.stringify(body),
  };
}

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }),
    { status: 200 },
  );
}

const SAMPLE_TOKENS = {
  productName: "Acme Rockets",
  voice: "Bold and kinetic",
  colors: [
    { name: "ink", hex: "#0E0E0E", role: "ink", usage: "type" },
    { name: "paper", hex: "#F4EEE4", role: "paper", usage: "bg" },
    { name: "flare", hex: "#E63946", role: "accent", usage: "accent" },
    { name: "gold", hex: "#E5A100", role: "secondary", usage: "secondary" },
    { name: "jade", hex: "#1F5F4A", role: "affirm", usage: "affirm" },
    { name: "steel", hex: "#7A756C", role: "neutral", usage: "hairlines" },
  ],
  typography: { display: "Fraunces", text: "Inter", mono: "JetBrains Mono" },
};

const VALID_COMPOSITION = `<!doctype html>
<html><head><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script></head>
<body>
<div id="root" data-composition-id="homepage" data-start="0" data-width="1920" data-height="1080" data-duration="6">
  <section id="hero" class="clip" data-start="0" data-duration="6" data-track-index="0"><h1 id="title">Acme</h1></section>
</div>
<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { opacity: 0, y: 40, duration: 0.6 }, 0.2);
  tl.to("#title", { opacity: 0, duration: 0.4 }, 5.4);
  tl.seek(0);
  window.__timelines["homepage"] = tl;
</script>
</body></html>`;

const SAMPLE_PAGE_HTML = `<!doctype html><html><head><title>Acme Rockets</title></head><body><h1>Fast</h1></body></html>`;

function routedFetch(pageHtml: string, ...geminiTexts: string[]): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("generativelanguage.googleapis.com")) {
      const text = geminiTexts[call] ?? geminiTexts[geminiTexts.length - 1]!;
      call += 1;
      return geminiResponse(text);
    }
    return new Response(pageHtml, { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  renderToCloudRunMock.mockClear();
});

describe("POST /v1/products/frame-pack", () => {
  it("returns a completed job with a download URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        routedFetch("", JSON.stringify(SAMPLE_TOKENS), '# FRAME.md\ncolors:\n  ink: "#0E0E0E"'),
      ),
    );
    const app = makeApp();

    const res = await app.request(
      "/v1/products/frame-pack",
      authed({ source_text: "Acme Rockets is a rocket company that ships fast." }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; download_url: string; files: string[] };
    expect(body.status).toBe("completed");
    expect(body.download_url).toContain("https://signed.test/");
    expect(body.files).toEqual(["FRAME.md", "frame-showcase.html", "README.html"]);
  });

  it("rejects a request with no source_text", async () => {
    const app = makeApp();
    const res = await app.request("/v1/products/frame-pack", authed({}));
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    const app = makeApp();
    const res = await app.request("/v1/products/frame-pack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_text: "x".repeat(30) }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 501 when GEMINI_API_KEY is not configured", async () => {
    const app = makeApp({ ...testEnv, geminiApiKey: "" });
    const res = await app.request(
      "/v1/products/frame-pack",
      authed({ source_text: "x".repeat(30) }),
    );
    expect(res.status).toBe(501);
  });
});

describe("POST /v1/products/website-video", () => {
  it("dispatches a render and returns a poll URL", async () => {
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, VALID_COMPOSITION));
    const app = makeApp();

    const res = await app.request(
      "/v1/products/website-video",
      authed({ url: "https://acme.example/", duration_s: 6 }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { render_id: string; status: string; poll_url: string };
    expect(body.render_id).toBe("hfr_test123");
    expect(body.status).toBe("rendering");
    expect(body.poll_url).toBe("/v3/kenectai/renders/hfr_test123");
    expect(renderToCloudRunMock).toHaveBeenCalledOnce();
  });

  it("passes a valid zipped project to the render dispatcher", async () => {
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, VALID_COMPOSITION));
    const app = makeApp();

    await app.request("/v1/products/website-video", authed({ url: "https://acme.example/" }));

    const call = renderToCloudRunMock.mock.calls[0]![0] as { projectDir: string };
    expect(call.projectDir).toBeTruthy();
  });

  it("rejects a non-HTTPS url", async () => {
    const app = makeApp();
    const res = await app.request(
      "/v1/products/website-video",
      authed({ url: "http://acme.example/" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 422 when the generated composition fails lint even after repair", async () => {
    const broken = VALID_COMPOSITION.replace('window.__timelines["homepage"] = tl;', "");
    vi.stubGlobal("fetch", routedFetch(SAMPLE_PAGE_HTML, broken, broken));
    const app = makeApp();

    const res = await app.request(
      "/v1/products/website-video",
      authed({ url: "https://acme.example/" }),
    );

    expect(res.status).toBe(422);
    expect(renderToCloudRunMock).not.toHaveBeenCalled();
  });
});
