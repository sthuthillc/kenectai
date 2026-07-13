/**
 * End-to-end tests for the self-contained OAuth 2.0 authorization-code +
 * PKCE server, driven through Hono's built-in `app.request()` test
 * helper against an in-memory GCS mock.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Storage } from "@google-cloud/storage";
import type { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createKenectApiApp, type KenectApiEnv } from "./server.js";

// The render SDK points at unbuilt workspace dist files; the OAuth tests
// never touch the render routes, so stub it out (vi.mock is hoisted
// above the server import).
vi.mock("@kenectai/gcp-cloud-run/sdk", () => ({
  renderToCloudRun: () => {
    throw new Error("renderToCloudRun is not available in oauth tests");
  },
  getRenderProgress: () => {
    throw new Error("getRenderProgress is not available in oauth tests");
  },
}));

const CLIENT_ID = "KajA15NGKvOCEG7bXdyzqJFs";
const REDIRECT_URI = "http://127.0.0.1:51234/oauth/callback";
// Includes characters that require URL encoding to prove verbatim round-trip.
const STATE = "state im verbatim+/=&?";
const FORM = "application/x-www-form-urlencoded";
const PASSWORD = "correct-horse-battery";

// --- in-memory GCS mock -----------------------------------------------------

class MemFile {
  constructor(
    private readonly files: Map<string, string>,
    private readonly key: string,
  ) {}

  async save(contents: string): Promise<void> {
    this.files.set(this.key, contents);
  }

  async exists(): Promise<[boolean]> {
    return [this.files.has(this.key)];
  }

  async download(): Promise<[Buffer]> {
    const value = this.files.get(this.key);
    if (value === undefined) throw new Error(`No such object: ${this.key}`);
    return [Buffer.from(value, "utf8")];
  }

  async delete(): Promise<void> {
    this.files.delete(this.key);
  }
}

class MemBucket {
  constructor(private readonly files: Map<string, string>) {}

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
  private readonly files = new Map<string, string>();

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
  apiKeys: [],
  jwtSecret: "test-secret",
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
};

function makeApp(): Hono {
  // The mock covers exactly the Storage surface JsonStore touches.
  const storage = new MemStorage() as unknown as Storage;
  return createKenectApiApp({ env: testEnv, storage });
}

// --- flow helpers -----------------------------------------------------------

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  return { verifier, challenge };
}

function flowParams(challenge: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email",
    state: STATE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...over,
  };
}

function postForm(app: Hono, path: string, fields: Record<string, string>, cookie?: string) {
  const headers: Record<string, string> = { "content-type": FORM };
  if (cookie) headers["cookie"] = cookie;
  return app.request(path, {
    method: "POST",
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

function sessionCookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

async function signup(app: Hono, email: string, challenge: string): Promise<Response> {
  return postForm(app, "/oauth/authorize/signup", {
    ...flowParams(challenge),
    email,
    password: PASSWORD,
  });
}

async function consentAllow(app: Hono, cookie: string, challenge: string): Promise<Response> {
  return postForm(
    app,
    "/oauth/authorize/consent",
    { ...flowParams(challenge), action: "allow" },
    cookie,
  );
}

/** Full signup → consent, returning the minted code + the flow's verifier. */
async function mintCode(
  app: Hono,
  email: string,
): Promise<{ code: string; verifier: string; cookie: string; location: URL }> {
  const { verifier, challenge } = pkcePair();
  const signupRes = await signup(app, email, challenge);
  expect(signupRes.status).toBe(302);
  const cookie = sessionCookieOf(signupRes);
  const consentRes = await consentAllow(app, cookie, challenge);
  expect(consentRes.status).toBe(302);
  const location = new URL(consentRes.headers.get("location") ?? "");
  return { code: location.searchParams.get("code") ?? "", verifier, cookie, location };
}

function exchangeCode(
  app: Hono,
  code: string,
  verifier: string,
  over: Record<string, string> = {},
): Promise<Response> {
  return postForm(app, "/v1/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    ...over,
  });
}

function refreshGrant(app: Hono, refreshToken: string): Promise<Response> {
  return postForm(app, "/v1/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null) throw new Error("expected JSON object body");
  return body as Record<string, unknown>;
}

// --- tests --------------------------------------------------------------------

describe("oauth authorize", () => {
  it("renders the login/signup page for a valid flow with no session", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    const res = await app.request(`/oauth/authorize?${new URLSearchParams(flowParams(challenge))}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/oauth/authorize/signup"');
    expect(html).toContain('action="/oauth/authorize/login"');
  });

  it("rejects a non-loopback redirect_uri with 400 and no redirect", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    const params = flowParams(challenge, { redirect_uri: "https://evil.example/oauth/callback" });
    const res = await app.request(`/oauth/authorize?${new URLSearchParams(params)}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("redirect_uri");
  });

  it("rejects an unknown client_id with 400 and no redirect", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    const params = flowParams(challenge, { client_id: "not-the-cli" });
    const res = await app.request(`/oauth/authorize?${new URLSearchParams(params)}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  it("signup sets a session cookie and the follow-up authorize renders consent", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    const email = "signup-consent@example.com";
    const res = await signup(app, email, challenge);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("kenect_session=");
    const cookie = sessionCookieOf(res);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/oauth/authorize?")).toBe(true);
    const followUp = await app.request(location, { headers: { cookie } });
    expect(followUp.status).toBe(200);
    const html = await followUp.text();
    expect(html).toContain('action="/oauth/authorize/consent"');
    expect(html).toContain(email);
  });

  it("consent allow redirects with a code and the exact state", async () => {
    const app = makeApp();
    const { code, location } = await mintCode(app, "consent-allow@example.com");
    expect(code.length).toBeGreaterThan(20);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(STATE);
  });

  it("consent deny redirects with error=access_denied and the state", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    const signupRes = await signup(app, "consent-deny@example.com", challenge);
    const cookie = sessionCookieOf(signupRes);
    const res = await postForm(
      app,
      "/oauth/authorize/consent",
      { ...flowParams(challenge), action: "deny" },
      cookie,
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(STATE);
  });

  it("login with a wrong password re-renders the form without a session cookie", async () => {
    const app = makeApp();
    const { challenge } = pkcePair();
    await signup(app, "wrong-password@example.com", challenge);
    const res = await postForm(app, "/oauth/authorize/login", {
      ...flowParams(challenge),
      email: "wrong-password@example.com",
      password: "not-the-password",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain('action="/oauth/authorize/login"');
    expect(html).toContain("Invalid email or password");
  });
});

describe("oauth token endpoint", () => {
  it("exchanges a code + verifier for the RFC 6749 token response shape", async () => {
    const app = makeApp();
    const { code, verifier } = await mintCode(app, "token-shape@example.com");
    const res = await exchangeCode(app, code, verifier);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(typeof body["access_token"]).toBe("string");
    expect(String(body["refresh_token"])).toMatch(/^krt_/);
    expect(body["token_type"]).toBe("Bearer");
    expect(body["scope"]).toBe("openid profile email");
    expect(body["expires_in"]).toBe(3600);
  });

  it("rejects a replayed authorization code (single-use)", async () => {
    const app = makeApp();
    const { code, verifier } = await mintCode(app, "code-replay@example.com");
    expect((await exchangeCode(app, code, verifier)).status).toBe(200);
    const replay = await exchangeCode(app, code, verifier);
    expect(replay.status).toBe(400);
    expect((await jsonBody(replay))["error"]).toBe("invalid_grant");
  });

  it("rejects a wrong code_verifier on a fresh code", async () => {
    const app = makeApp();
    const { code } = await mintCode(app, "wrong-verifier@example.com");
    const res = await exchangeCode(app, code, randomBytes(32).toString("base64url"));
    expect(res.status).toBe(400);
    expect((await jsonBody(res))["error"]).toBe("invalid_grant");
  });

  it("rejects an unsupported grant_type", async () => {
    const app = makeApp();
    const res = await postForm(app, "/v1/oauth/token", { grant_type: "password" });
    expect(res.status).toBe(400);
    expect((await jsonBody(res))["error"]).toBe("unsupported_grant_type");
  });

  it("rotates refresh tokens and rejects the previous one", async () => {
    const app = makeApp();
    const { code, verifier } = await mintCode(app, "refresh-rotate@example.com");
    const first = await jsonBody(await exchangeCode(app, code, verifier));
    const oldRefresh = String(first["refresh_token"]);

    const rotated = await refreshGrant(app, oldRefresh);
    expect(rotated.status).toBe(200);
    const second = await jsonBody(rotated);
    expect(typeof second["access_token"]).toBe("string");
    expect(String(second["refresh_token"])).toMatch(/^krt_/);
    expect(second["refresh_token"]).not.toBe(oldRefresh);

    const replay = await refreshGrant(app, oldRefresh);
    expect(replay.status).toBe(400);
    expect((await jsonBody(replay))["error"]).toBe("invalid_grant");
  });

  it("revoke deletes a refresh token and always returns 200", async () => {
    const app = makeApp();
    const { code, verifier } = await mintCode(app, "revoke@example.com");
    const tokens = await jsonBody(await exchangeCode(app, code, verifier));
    const refreshToken = String(tokens["refresh_token"]);

    const revoke = await postForm(app, "/v1/oauth/revoke", { token: refreshToken });
    expect(revoke.status).toBe(200);
    expect(await jsonBody(revoke)).toEqual({ revoked: true });

    const afterRevoke = await refreshGrant(app, refreshToken);
    expect(afterRevoke.status).toBe(400);
    expect((await jsonBody(afterRevoke))["error"]).toBe("invalid_grant");

    // Unknown tokens still get 200 (RFC 7009 — don't leak validity).
    const bogus = await postForm(app, "/v1/oauth/revoke", { token: "krt_bogus" });
    expect(bogus.status).toBe(200);
    expect(await jsonBody(bogus)).toEqual({ revoked: true });
  });
});

describe("bearer identity", () => {
  it("GET /v3/users/me returns the signup email for a Bearer access token", async () => {
    const app = makeApp();
    const email = "bearer-me@example.com";
    const { code, verifier } = await mintCode(app, email);
    const tokens = await jsonBody(await exchangeCode(app, code, verifier));
    const res = await app.request("/v3/users/me", {
      headers: { authorization: `Bearer ${String(tokens["access_token"])}` },
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const payload = body["data"];
    expect(payload).toMatchObject({
      username: "bearer-me",
      email,
      billing_type: "usage_based",
    });
  });
});
