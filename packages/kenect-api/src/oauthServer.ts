/**
 * Self-contained OAuth 2.0 authorization-code + PKCE server for the
 * Kenect AI CLI (a public client with a loopback redirect — RFC 8252).
 *
 * No third-party identity provider: users, authorization codes, and
 * refresh tokens live in the same GCS-backed JSON store the rest of the
 * API uses, and every primitive comes from node:crypto (scrypt password
 * hashes, HMAC-signed session cookies, hand-rolled HS256 access tokens).
 */

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { KenectApiEnv } from "./server.js";

/** The single recognized public client (the Kenect AI CLI). */
export const OAUTH_CLIENT_ID = "KajA15NGKvOCEG7bXdyzqJFs";

const SESSION_COOKIE_NAME = "kenect_session";
const SESSION_TTL_SECONDS = 30 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_CODE_TTL_SECONDS = 60;
const REFRESH_TOKEN_PREFIX = "krt_";
const TOKEN_SCOPE = "openid profile email";
const MIN_PASSWORD_LENGTH = 8;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Structural view of the JsonStore in server.ts (kept private there). */
export interface JsonStoreLike {
  write<T>(key: string, value: T): Promise<void>;
  read<T>(key: string): Promise<T | null>;
  list<T>(prefix: string, limit: number): Promise<T[]>;
  delete(key: string): Promise<void>;
}

interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: number;
}

interface AuthCodeRecord {
  user_id: string;
  email: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
}

interface RefreshTokenRecord {
  user_id: string;
  email: string;
  created_at: number;
  expires_at: number;
}

interface SessionPayload {
  uid: string;
  email: string;
  exp: number;
}

interface FlowParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
}

const FLOW_PARAM_KEYS: readonly (keyof FlowParams)[] = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
];

type FlowCheck =
  | { kind: "ok"; flow: FlowParams }
  | { kind: "fatal"; message: string }
  | { kind: "redirect"; location: string };

// --- crypto helpers -------------------------------------------------------

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest().toString("base64url");
}

function hmacBase64Url(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest().toString("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveScryptKey(
  password: string,
  salt: Buffer,
  keylen: number,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N: params.N, r: params.r, p: params.p }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveScryptKey(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await deriveScryptKey(password, salt, expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// --- session cookies ------------------------------------------------------

function createSessionValue(user: { id: string; email: string }, jwtSecret: string): string {
  const payload = base64UrlJson({
    uid: user.id,
    email: user.email,
    exp: nowSeconds() + SESSION_TTL_SECONDS,
  });
  return `${payload}.${hmacBase64Url(payload, jwtSecret)}`;
}

function verifySessionValue(value: string, jwtSecret: string): SessionPayload | null {
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!constantTimeEqual(signature, hmacBase64Url(payload, jwtSecret))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const uid = parsed["uid"];
  const email = parsed["email"];
  const exp = parsed["exp"];
  if (typeof uid !== "string" || typeof email !== "string" || typeof exp !== "number") return null;
  if (exp <= nowSeconds()) return null;
  return { uid, email, exp };
}

function readSession(c: Context, jwtSecret: string): SessionPayload | null {
  const value = getCookie(c, SESSION_COOKIE_NAME);
  return value ? verifySessionValue(value, jwtSecret) : null;
}

function setSessionCookie(
  c: Context,
  user: { id: string; email: string },
  jwtSecret: string,
): void {
  setCookie(c, SESSION_COOKIE_NAME, createSessionValue(user, jwtSecret), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/oauth",
    maxAge: SESSION_TTL_SECONDS,
  });
}

// --- access tokens (HS256 JWT) ---------------------------------------------

function signAccessToken(user: { id: string; email: string }, jwtSecret: string): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const now = nowSeconds();
  const payload = base64UrlJson({
    sub: user.id,
    email: user.email,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  const signature = hmacBase64Url(`${header}.${payload}`, jwtSecret);
  return `${header}.${payload}.${signature}`;
}

/**
 * Validate an `Authorization: Bearer <jwt>` header against our HS256
 * access tokens. Returns null (never throws) for anything that isn't a
 * valid, unexpired token — callers fall through to API-key auth.
 */
export function resolveBearerIdentity(
  authorizationHeader: string | null | undefined,
  jwtSecret: string,
): { userId: string; email: string } | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match || !match[1]) return null;
  const segments = match[1].split(".");
  if (segments.length !== 3) return null;
  const [header, payload, signature] = segments;
  if (!header || !payload || !signature) return null;
  if (!constantTimeEqual(signature, hmacBase64Url(`${header}.${payload}`, jwtSecret))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(claims)) return null;
  const sub = claims["sub"];
  const email = claims["email"];
  const exp = claims["exp"];
  if (typeof sub !== "string" || typeof email !== "string" || typeof exp !== "number") return null;
  if (exp <= nowSeconds()) return null;
  return { userId: sub, email };
}

// --- storage keys -----------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function userKey(normalizedEmail: string): string {
  return `users/${sha256Hex(normalizedEmail)}.json`;
}

function authCodeKey(code: string): string {
  return `auth_codes/${sha256Hex(code)}.json`;
}

function refreshTokenKey(token: string): string {
  return `refresh_tokens/${sha256Hex(token)}.json`;
}

// --- flow parameter validation ----------------------------------------------

/**
 * Loopback-only redirect for the public CLI client: any port, fixed
 * `/oauth/callback` path, http on 127.0.0.1 or localhost (RFC 8252 §7.3).
 */
function isLoopbackRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  return url.pathname === "/oauth/callback";
}

/**
 * Fixed HTTPS redirect for the first-party web dashboard (the same public
 * PKCE client as the CLI, so no client secret either way). Exact-match only —
 * defaults to the production web app, overridable for staging via
 * KENECT_WEB_REDIRECT_URIS (comma-separated exact URIs).
 */
const WEB_REDIRECT_URIS: readonly string[] = (
  process.env["KENECT_WEB_REDIRECT_URIS"]?.trim() || "https://kenectai.com/auth/callback"
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function isAllowedRedirect(uri: string): boolean {
  return isLoopbackRedirect(uri) || WEB_REDIRECT_URIS.includes(uri);
}

function redirectWithError(
  redirectUri: string,
  error: string,
  description: string,
  state: string,
): string {
  const params = new URLSearchParams({ error, error_description: description });
  if (state) params.set("state", state);
  return `${redirectUri}?${params.toString()}`;
}

/**
 * Validate the authorize-flow parameters. Bad client_id / redirect_uri
 * are fatal (400 page — RFC 6749 §4.1.2.1 forbids redirecting to an
 * unvalidated URI); other failures redirect back with an error code.
 */
function checkFlow(get: (name: string) => string | undefined): FlowCheck {
  const clientId = get("client_id") ?? "";
  if (clientId !== OAUTH_CLIENT_ID) {
    return { kind: "fatal", message: "Unknown client_id." };
  }
  const redirectUri = get("redirect_uri") ?? "";
  if (!isAllowedRedirect(redirectUri)) {
    return {
      kind: "fatal",
      message:
        "redirect_uri must be a loopback URL of the form http://127.0.0.1:<port>/oauth/callback, or the registered web app callback.",
    };
  }
  const state = get("state") ?? "";
  const fail = (error: string, description: string): FlowCheck => ({
    kind: "redirect",
    location: redirectWithError(redirectUri, error, description, state),
  });
  if ((get("response_type") ?? "") !== "code") {
    return fail("unsupported_response_type", "response_type must be code");
  }
  if (!state) return fail("invalid_request", "state is required");
  const codeChallenge = get("code_challenge") ?? "";
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required");
  if ((get("code_challenge_method") ?? "") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  return {
    kind: "ok",
    flow: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: get("scope") ?? TOKEN_SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    },
  };
}

function flowQuery(flow: FlowParams): string {
  const params = new URLSearchParams();
  for (const key of FLOW_PARAM_KEYS) params.set(key, flow[key]);
  return params.toString();
}

// --- HTML pages ---------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0b0f14;color:#e6e8eb}" +
  "main{width:100%;max-width:420px;padding:32px;border-radius:12px;background:#11161d;border:1px solid #1f2630;box-sizing:border-box}" +
  "h1{font-weight:600;font-size:20px;margin:0 0 8px;color:#3CE6AC}" +
  "h2{font-weight:600;font-size:14px;margin:24px 0 4px;color:#e6e8eb}" +
  "p{margin:0 0 8px;color:#9aa3ad;font-size:14px}" +
  "label{display:block;font-size:12px;color:#9aa3ad;margin:12px 0 4px}" +
  "input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid #1f2630;background:#0b0f14;color:#e6e8eb}" +
  "button{margin-top:16px;width:100%;padding:10px;border-radius:8px;border:0;background:#3CE6AC;color:#0b0f14;font-weight:600;cursor:pointer}" +
  "button.secondary{background:#1f2630;color:#e6e8eb}" +
  "code{background:#1f2630;padding:2px 6px;border-radius:4px}" +
  ".error{margin:12px 0 0;padding:8px 10px;border-radius:8px;background:#2a1414;color:#ff7a7a;font-size:13px}" +
  "hr{border:0;border-top:1px solid #1f2630;margin:24px 0}";

function pageShell(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`
  );
}

function hiddenInputs(flow: FlowParams): string {
  return FLOW_PARAM_KEYS.map(
    (key) => `<input type="hidden" name="${key}" value="${escapeHtml(flow[key])}">`,
  ).join("");
}

function loginPage(flow: FlowParams, errorMessage?: string): string {
  const hidden = hiddenInputs(flow);
  const error = errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : "";
  return pageShell(
    "Sign in to Kenect AI",
    `<h1>Kenect AI</h1>` +
      `<p>Sign in to authorize the Kenect AI CLI.</p>` +
      error +
      `<h2>Sign in</h2>` +
      `<form method="post" action="/oauth/authorize/login">${hidden}` +
      `<label for="login-email">Email</label>` +
      `<input id="login-email" name="email" type="email" autocomplete="email" required>` +
      `<label for="login-password">Password</label>` +
      `<input id="login-password" name="password" type="password" autocomplete="current-password" required>` +
      `<button type="submit">Sign in</button></form>` +
      `<hr>` +
      `<h2>Create an account</h2>` +
      `<form method="post" action="/oauth/authorize/signup">${hidden}` +
      `<label for="signup-email">Email</label>` +
      `<input id="signup-email" name="email" type="email" autocomplete="email" required>` +
      `<label for="signup-password">Password (min ${MIN_PASSWORD_LENGTH} characters)</label>` +
      `<input id="signup-password" name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required>` +
      `<button type="submit" class="secondary">Sign up</button></form>`,
  );
}

function consentPage(flow: FlowParams, email: string): string {
  return pageShell(
    "Authorize Kenect AI CLI",
    `<h1>Authorize Kenect AI CLI</h1>` +
      `<p>Signed in as <strong>${escapeHtml(email)}</strong>.</p>` +
      `<p>The Kenect AI CLI is requesting access to your account: <code>${escapeHtml(flow.scope)}</code></p>` +
      `<form method="post" action="/oauth/authorize/consent">${hiddenInputs(flow)}` +
      `<button type="submit" name="action" value="allow">Authorize Kenect AI CLI</button>` +
      `<button type="submit" name="action" value="deny" class="secondary">Deny</button></form>`,
  );
}

function errorPage(code: string, description: string): string {
  return pageShell(
    "Authorization error",
    `<h1>Authorization error</h1><p><code>${escapeHtml(code)}</code></p><p>${escapeHtml(description)}</p>`,
  );
}

// --- route registration ---------------------------------------------------------

export function registerOAuthRoutes(
  app: Hono,
  deps: { env: KenectApiEnv; store: JsonStoreLike; jwtSecret: string },
): void {
  const { store, jwtSecret } = deps;

  // parseBody throws on non-form bodies; treat those as an empty form so
  // the per-field validation produces the specific OAuth error instead.
  async function readForm(c: Context): Promise<Record<string, string>> {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }

  function tokenError(c: Context, error: string, description: string): Response {
    return c.json({ error, error_description: description }, 400);
  }

  async function issueTokenResponse(
    c: Context,
    user: { id: string; email: string },
  ): Promise<Response> {
    const refreshToken = REFRESH_TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const now = nowSeconds();
    const record: RefreshTokenRecord = {
      user_id: user.id,
      email: user.email,
      created_at: now,
      expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
    };
    await store.write(refreshTokenKey(refreshToken), record);
    return c.json({
      access_token: signAccessToken(user, jwtSecret),
      refresh_token: refreshToken,
      token_type: "Bearer",
      scope: TOKEN_SCOPE,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  app.get("/oauth/authorize", (c) => {
    const check = checkFlow((name) => c.req.query(name));
    if (check.kind === "fatal") return c.html(errorPage("invalid_request", check.message), 400);
    if (check.kind === "redirect") return c.redirect(check.location, 302);
    const session = readSession(c, jwtSecret);
    if (!session) return c.html(loginPage(check.flow));
    return c.html(consentPage(check.flow, session.email));
  });

  app.post("/oauth/authorize/login", async (c) => {
    const form = await readForm(c);
    const check = checkFlow((name) => form[name]);
    if (check.kind === "fatal") return c.html(errorPage("invalid_request", check.message), 400);
    if (check.kind === "redirect") return c.redirect(check.location, 302);
    const email = normalizeEmail(form["email"] ?? "");
    const password = form["password"] ?? "";
    if (!email || !password) {
      return c.html(loginPage(check.flow, "Email and password are required."), 400);
    }
    const user = await store.read<UserRecord>(userKey(email));
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return c.html(loginPage(check.flow, "Invalid email or password."), 401);
    }
    setSessionCookie(c, user, jwtSecret);
    return c.redirect(`/oauth/authorize?${flowQuery(check.flow)}`, 302);
  });

  app.post("/oauth/authorize/signup", async (c) => {
    const form = await readForm(c);
    const check = checkFlow((name) => form[name]);
    if (check.kind === "fatal") return c.html(errorPage("invalid_request", check.message), 400);
    if (check.kind === "redirect") return c.redirect(check.location, 302);
    const email = normalizeEmail(form["email"] ?? "");
    const password = form["password"] ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.html(loginPage(check.flow, "Enter a valid email address."), 400);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return c.html(
        loginPage(check.flow, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`),
        400,
      );
    }
    const existing = await store.read<UserRecord>(userKey(email));
    if (existing) {
      return c.html(
        loginPage(check.flow, "An account with that email already exists. Sign in instead."),
        409,
      );
    }
    const user: UserRecord = {
      id: `usr_${randomBytes(12).toString("hex")}`,
      email,
      name: email.split("@")[0] ?? email,
      password_hash: await hashPassword(password),
      created_at: nowSeconds(),
    };
    await store.write(userKey(email), user);
    setSessionCookie(c, user, jwtSecret);
    return c.redirect(`/oauth/authorize?${flowQuery(check.flow)}`, 302);
  });

  app.post("/oauth/authorize/consent", async (c) => {
    const form = await readForm(c);
    const check = checkFlow((name) => form[name]);
    if (check.kind === "fatal") return c.html(errorPage("invalid_request", check.message), 400);
    if (check.kind === "redirect") return c.redirect(check.location, 302);
    const session = readSession(c, jwtSecret);
    if (!session) {
      return c.html(
        errorPage("session_expired", "Your session has expired. Restart login from your terminal."),
        401,
      );
    }
    const action = form["action"] ?? "";
    if (action === "deny") {
      return c.redirect(
        redirectWithError(
          check.flow.redirect_uri,
          "access_denied",
          "The user denied the authorization request.",
          check.flow.state,
        ),
        302,
      );
    }
    if (action !== "allow") {
      return c.html(errorPage("invalid_request", "action must be allow or deny."), 400);
    }
    const code = randomBytes(32).toString("base64url");
    const record: AuthCodeRecord = {
      user_id: session.uid,
      email: session.email,
      client_id: check.flow.client_id,
      redirect_uri: check.flow.redirect_uri,
      code_challenge: check.flow.code_challenge,
      expires_at: nowSeconds() + AUTH_CODE_TTL_SECONDS,
    };
    await store.write(authCodeKey(code), record);
    const params = new URLSearchParams({ code, state: check.flow.state });
    return c.redirect(`${check.flow.redirect_uri}?${params.toString()}`, 302);
  });

  app.post("/v1/oauth/token", async (c) => {
    const form = await readForm(c);
    const grantType = form["grant_type"] ?? "";

    if (grantType === "authorization_code") {
      const code = form["code"] ?? "";
      const clientId = form["client_id"] ?? "";
      const redirectUri = form["redirect_uri"] ?? "";
      const codeVerifier = form["code_verifier"] ?? "";
      if (!code || !clientId || !redirectUri || !codeVerifier) {
        return tokenError(
          c,
          "invalid_request",
          "code, client_id, redirect_uri, and code_verifier are required",
        );
      }
      const key = authCodeKey(code);
      const record = await store.read<AuthCodeRecord>(key);
      if (!record) {
        return tokenError(c, "invalid_grant", "authorization code is invalid or already used");
      }
      if (record.expires_at <= nowSeconds()) {
        await store.delete(key);
        return tokenError(c, "invalid_grant", "authorization code expired");
      }
      if (clientId !== record.client_id) {
        return tokenError(c, "invalid_grant", "client_id does not match the authorization request");
      }
      if (redirectUri !== record.redirect_uri) {
        return tokenError(
          c,
          "invalid_grant",
          "redirect_uri does not match the authorization request",
        );
      }
      if (!constantTimeEqual(sha256Base64Url(codeVerifier), record.code_challenge)) {
        return tokenError(c, "invalid_grant", "code_verifier does not match code_challenge");
      }
      // Single-use: revoke the code before minting anything so a raced
      // second redemption can't also succeed.
      await store.delete(key);
      return issueTokenResponse(c, { id: record.user_id, email: record.email });
    }

    if (grantType === "refresh_token") {
      const refreshToken = form["refresh_token"] ?? "";
      if (!refreshToken) return tokenError(c, "invalid_request", "refresh_token is required");
      const key = refreshTokenKey(refreshToken);
      const record = await store.read<RefreshTokenRecord>(key);
      if (!record) return tokenError(c, "invalid_grant", "refresh token is invalid or revoked");
      if (record.expires_at <= nowSeconds()) {
        await store.delete(key);
        return tokenError(c, "invalid_grant", "refresh token expired");
      }
      // Rotation: the presented token dies here, success or not beyond
      // this point — a replayed old token must always be rejected.
      await store.delete(key);
      return issueTokenResponse(c, { id: record.user_id, email: record.email });
    }

    return tokenError(c, "unsupported_grant_type", `unsupported grant_type "${grantType}"`);
  });

  // RFC 7009: always 200 so callers can't probe token validity.
  app.post("/v1/oauth/revoke", async (c) => {
    const form = await readForm(c);
    const token = form["token"] ?? "";
    if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
      await store.delete(refreshTokenKey(token));
    }
    return c.json({ revoked: true });
  });
}
