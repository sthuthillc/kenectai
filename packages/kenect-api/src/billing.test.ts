/**
 * Billing tests: webhook signature verification, checkout, per-user API
 * keys, and quota enforcement on the paid routes — driven through Hono's
 * `app.request()` against the same in-memory GCS mock as the other suites.
 * Stripe's API is a stubbed `fetch`; no network.
 */

import { createHmac } from "node:crypto";
import type { Storage } from "@google-cloud/storage";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKenectApiApp, type KenectApiEnv } from "./server.js";
import { PLAN_MONTHLY_RENDERS, verifyStripeSignature } from "./billing.js";

vi.mock("@kenectai/gcp-cloud-run/sdk", () => ({
  renderToCloudRun: vi.fn(async () => ({
    renderId: "hfr_test123",
    executionName: "projects/test/executions/exec-1",
    outputGcsUri: "gs://test-bucket/renders/hfr_test123/output.mp4",
    projectGcsUri: "gs://test-bucket/renders/hfr_test123/project.zip",
  })),
  getRenderProgress: () => {
    throw new Error("getRenderProgress is not used by billing tests");
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
  readonly files = new Map<string, Buffer>();
  bucket(_name: string): MemBucket {
    return new MemBucket(this.files);
  }
}

const WEBHOOK_SECRET = "whsec_testsecret";

const testEnv: KenectApiEnv = {
  apiBaseUrl: "https://api.test",
  appBaseUrl: "https://app.test",
  uploadBucket: "test-bucket",
  renderBucket: "test-bucket",
  projectId: "test-project",
  renderLocation: "us-central1",
  renderWorkflowId: "test-workflow",
  renderServiceUrl: "https://render.test",
  apiKeys: ["test-admin-key"],
  jwtSecret: "test-secret",
  geminiApiKey: "test-gemini-key",
  geminiModel: "gemini-2.5-flash",
  stripeSecretKey: "sk_test_fake",
  stripeWebhookSecret: WEBHOOK_SECRET,
  stripePriceId: "price_test_premium",
};

function makeApp(): { app: Hono; files: Map<string, Buffer> } {
  const storage = new MemStorage();
  const app = createKenectApiApp({ env: testEnv, storage: storage as unknown as Storage });
  return { app, files: storage.files };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Mint a Bearer JWT matching oauthServer's HS256 format. */
function makeJwt(userId: string, email: string): string {
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url({ sub: userId, email, iat: now, exp: now + 3600 });
  const signature = createHmac("sha256", testEnv.jwtSecret)
    .update(`${header}.${payload}`)
    .digest()
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function signWebhook(
  rawBody: string,
  secret = WEBHOOK_SECRET,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Seed a billing record directly in the store, as the webhook would. */
function seedBilling(files: Map<string, Buffer>, userId: string, status = "active"): void {
  files.set(
    `billing/${userId}.json`,
    Buffer.from(
      JSON.stringify({
        user_id: userId,
        email: "u@test.dev",
        stripe_customer_id: "cus_test",
        stripe_subscription_id: "sub_test",
        status,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
        updated_at: Math.floor(Date.now() / 1000),
      }),
      "utf8",
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyStripeSignature", () => {
  it("accepts a valid signature and rejects a tampered body", () => {
    const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
    const header = signWebhook(body);
    expect(verifyStripeSignature(body, header, WEBHOOK_SECRET)).toBe(true);
    expect(verifyStripeSignature(body + "x", header, WEBHOOK_SECRET)).toBe(false);
    expect(verifyStripeSignature(body, header, "whsec_wrong")).toBe(false);
  });

  it("rejects a stale timestamp", () => {
    const body = "{}";
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect(
      verifyStripeSignature(body, signWebhook(body, WEBHOOK_SECRET, stale), WEBHOOK_SECRET),
    ).toBe(false);
  });
});

describe("POST /v1/billing/webhook", () => {
  it("rejects an unsigned request", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed" }),
    });
    expect(res.status).toBe(400);
  });

  it("activates the user's plan on checkout.session.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "sub_123",
              customer: "cus_123",
              status: "active",
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
            }),
            { status: 200 },
          ),
      ),
    );
    const { app, files } = makeApp();
    const body = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          client_reference_id: "user_42",
          customer_details: { email: "u@test.dev" },
          subscription: "sub_123",
        },
      },
    });

    const res = await app.request("/v1/billing/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signWebhook(body) },
      body,
    });

    expect(res.status).toBe(200);
    const record = JSON.parse(files.get("billing/user_42.json")!.toString("utf8")) as {
      status: string;
      stripe_subscription_id: string;
    };
    expect(record.status).toBe("active");
    expect(record.stripe_subscription_id).toBe("sub_123");
    expect(files.has("stripe_customers/cus_123.json")).toBe(true);
  });
});

describe("POST /v1/billing/checkout", () => {
  it("requires a signed-in user", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/billing/checkout", {
      method: "POST",
      headers: { "x-api-key": "test-admin-key" },
    });
    expect(res.status).toBe(401);
  });

  it("creates a Stripe checkout session for a Bearer user", async () => {
    const stripeFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/cs_test_1" }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", stripeFetch);
    const { app } = makeApp();

    const res = await app.request("/v1/billing/checkout", {
      method: "POST",
      headers: { authorization: `Bearer ${makeJwt("user_42", "u@test.dev")}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string };
    expect(body.checkout_url).toContain("checkout.stripe.com");
    const [url, init] = stripeFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(String(init.body)).toContain("client_reference_id=user_42");
    expect(String(init.body)).toContain(encodeURIComponent("price_test_premium"));
  });
});

describe("per-user API keys", () => {
  it("issues a kn_ key for a Bearer user and lists its prefix", async () => {
    const { app } = makeApp();
    const jwt = makeJwt("user_42", "u@test.dev");

    const createRes = await app.request("/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "ci" }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as { api_key: string };
    expect(created.api_key).toMatch(/^kn_[0-9a-f]{48}$/);

    const listRes = await app.request("/v1/keys", {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const listed = (await listRes.json()) as { keys: Array<{ prefix: string; label: string }> };
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]!.label).toBe("ci");
    expect(created.api_key.startsWith(listed.keys[0]!.prefix)).toBe(true);
  });

  it("rejects key creation with only an admin API key", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/keys", {
      method: "POST",
      headers: { "x-api-key": "test-admin-key" },
    });
    expect(res.status).toBe(401);
  });
});

describe("quota enforcement on paid routes", () => {
  async function issueKey(app: Hono): Promise<string> {
    const res = await app.request("/v1/keys", {
      method: "POST",
      headers: { authorization: `Bearer ${makeJwt("user_42", "u@test.dev")}` },
    });
    return ((await res.json()) as { api_key: string }).api_key;
  }

  it("blocks a user with no subscription with 402", async () => {
    const { app } = makeApp();
    const key = await issueKey(app);
    const res = await app.request("/v1/products/frame-pack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ source_text: "x".repeat(30) }),
    });
    expect(res.status).toBe(402);
  });

  it("lets a subscribed user through and counts usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          productName: "Acme",
                          voice: "Bold",
                          colors: [
                            { name: "a", hex: "#000000", role: "ink", usage: "type" },
                            { name: "b", hex: "#ffffff", role: "paper", usage: "bg" },
                            { name: "c", hex: "#ff0000", role: "accent", usage: "accent" },
                            { name: "d", hex: "#00ff00", role: "secondary", usage: "secondary" },
                            { name: "e", hex: "#0000ff", role: "affirm", usage: "affirm" },
                            { name: "f", hex: "#888888", role: "neutral", usage: "hairlines" },
                          ],
                          typography: {
                            display: "Fraunces",
                            text: "Inter",
                            mono: "JetBrains Mono",
                          },
                        }),
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const { app, files } = makeApp();
    const key = await issueKey(app);
    seedBilling(files, "user_42");

    const res = await app.request("/v1/products/frame-pack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ source_text: "Acme is a rocket company that ships fast." }),
    });

    expect(res.status).toBe(200);
    const month = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const usage = JSON.parse(files.get(`usage/user_42/${month}.json`)!.toString("utf8")) as {
      count: number;
    };
    expect(usage.count).toBe(1);
  });

  it("blocks a subscribed user who exhausted the monthly quota", async () => {
    const { app, files } = makeApp();
    const key = await issueKey(app);
    seedBilling(files, "user_42");
    const month = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    files.set(
      `usage/user_42/${month}.json`,
      Buffer.from(JSON.stringify({ count: PLAN_MONTHLY_RENDERS })),
    );

    const res = await app.request("/v1/products/frame-pack", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ source_text: "x".repeat(30) }),
    });
    expect(res.status).toBe(402);
  });

  it("lets static admin keys bypass billing entirely", async () => {
    const { app } = makeApp();
    const res = await app.request("/v1/billing/status", {
      headers: { "x-api-key": "test-admin-key" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { plan: string }).plan).toBe("admin");
  });
});
