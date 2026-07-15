/**
 * Route-level tests for the thin MCP wrapper, driven through Hono's
 * `app.request()` against the same in-memory GCS mock and stubbed `fetch`
 * pattern as server.products.test.ts. Exercises the real JSON-RPC/MCP
 * protocol shape (initialize, tools/list, tools/call), not the underlying
 * business logic — that's already covered by server.products.test.ts, and
 * these tools are thin forwards to those same routes.
 */

import type { Storage } from "@google-cloud/storage";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKenectApiApp, type KenectApiEnv } from "./server.js";

vi.mock("@kenectai/gcp-cloud-run/sdk", () => ({
  renderToCloudRun: vi.fn(async () => ({
    renderId: "hfr_test123",
    executionName: "projects/test/executions/exec-1",
    outputGcsUri: "gs://test-bucket/renders/hfr_test123/output.mp4",
    projectGcsUri: "gs://test-bucket/renders/hfr_test123/project.zip",
  })),
  getRenderProgress: () => {
    throw new Error("getRenderProgress is not used by mcp tests");
  },
}));

// --- in-memory GCS mock (same shape as server.products.test.ts) ---

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
  async getSignedUrl(): Promise<[string]> {
    return [`https://signed.test/${this.key}`];
  }
}

class MemBucket {
  constructor(private readonly files: Map<string, Buffer>) {}
  file(key: string): MemFile {
    return new MemFile(this.files, key);
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
  stripeSecretKey: "",
  stripeWebhookSecret: "",
  stripePriceId: "",
};

function makeApp(): Hono {
  const storage = new MemStorage() as unknown as Storage;
  return createKenectApiApp({ env: testEnv, storage });
}

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }),
    { status: 200 },
  );
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "x-api-key": "test-api-key",
};

async function mcpRequest(app: Hono, method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { message: string };
  };
  return { status: res.status, body };
}

function initParams() {
  return {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /mcp — initialize + tools/list", () => {
  it("negotiates a session and lists the three loose tools", async () => {
    const app = makeApp();

    const init = await mcpRequest(app, "initialize", initParams());
    expect(init.status).toBe(200);
    expect(init.body.result?.serverInfo).toMatchObject({ name: "kenectai" });

    const list = await mcpRequest(app, "tools/list");
    expect(list.status).toBe(200);
    const tools = (list.body.result?.tools ?? []) as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["create_frame_pack", "create_video_from_url", "get_video_status"]);
  });

  it("rejects unauthenticated requests, matching the REST routes", async () => {
    const app = makeApp();
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams() }),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp — tools/call create_frame_pack", () => {
  it("forwards to /v1/products/frame-pack and surfaces the download_url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        geminiResponse(
          JSON.stringify({
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
          }),
        ),
      ),
    );
    const app = makeApp();

    const res = await mcpRequest(app, "tools/call", {
      name: "create_frame_pack",
      arguments: { source_text: "Acme Rockets is a rocket company that ships fast." },
    });

    expect(res.status).toBe(200);
    const content = res.body.result?.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { status: string; download_url: string };
    expect(parsed.status).toBe("completed");
    expect(parsed.download_url).toContain("https://signed.test/");
    expect(res.body.result?.isError).not.toBe(true);
  });

  it("surfaces a validation error from the underlying route as a tool error", async () => {
    const app = makeApp();
    const res = await mcpRequest(app, "tools/call", {
      name: "create_frame_pack",
      arguments: { source_text: "too short" },
    });
    // Zod's own inputSchema.min(20) rejects this before it ever reaches the route.
    expect(res.status).toBe(200);
    expect(res.body.error ?? res.body.result?.isError).toBeTruthy();
  });
});

describe("POST /mcp — tools/call get_video_status", () => {
  it("forwards to /v3/kenectai/renders/:id and surfaces a not-found as a tool error", async () => {
    const app = makeApp();

    const res = await mcpRequest(app, "tools/call", {
      name: "get_video_status",
      arguments: { render_id: "hfr_missing" },
    });

    expect(res.status).toBe(200);
    const content = res.body.result?.content as Array<{ type: string; text: string }>;
    expect(res.body.result?.isError).toBe(true);
    expect(content[0]!.text).toMatch(/404|not found/i);
  });
});
