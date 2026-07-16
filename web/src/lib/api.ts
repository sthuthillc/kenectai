/**
 * API client for the kenect-api backend, plus the browser half of the OAuth
 * authorization-code + PKCE flow. All requests go to same-origin paths
 * (/v1/*, /v3/*, /oauth/*) — nginx proxies them to api.kenectai.com in
 * production and Vite's dev-server proxy does the same locally, so no CORS.
 */

// The same public PKCE client as the CLI (no client secret in either).
export const OAUTH_CLIENT_ID = "KajA15NGKvOCEG7bXdyzqJFs";

const TOKEN_KEY = "kenect.tokens";
const VERIFIER_KEY = "kenect.pkce_verifier";
const STATE_KEY = "kenect.pkce_state";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
}

function redirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

// ── token storage ───────────────────────────────────────────────────────────

function readTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

function writeTokens(tokens: StoredTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function signOut(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isSignedIn(): boolean {
  const tokens = readTokens();
  return tokens !== null && (tokens.expires_at > nowSeconds() || !!tokens.refresh_token);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── PKCE flow ───────────────────────────────────────────────────────────────

/** Kick off sign-in: stash verifier+state, then leave for /oauth/authorize. */
export async function startSignIn(returnTo = "/dashboard"): Promise<void> {
  const verifier = randomToken(48);
  const state = randomToken(24);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, JSON.stringify({ state, returnTo }));
  const challenge = await sha256Base64Url(verifier);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.assign(`/oauth/authorize?${params.toString()}`);
}

/** Complete sign-in on /auth/callback. Returns the post-login destination. */
export async function completeSignIn(query: URLSearchParams): Promise<string> {
  const error = query.get("error");
  if (error) throw new Error(query.get("error_description") ?? error);
  const code = query.get("code");
  const state = query.get("state");
  const stashedRaw = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!code || !state || !stashedRaw || !verifier) {
    throw new Error("Sign-in session expired — please try again.");
  }
  const stashed = JSON.parse(stashedRaw) as { state: string; returnTo: string };
  if (stashed.state !== state) throw new Error("State mismatch — please try signing in again.");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  const res = await fetch("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message ?? `Token exchange failed (HTTP ${res.status})`);
  }
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  writeTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: nowSeconds() + tokens.expires_in - 30,
  });
  return stashed.returnTo || "/dashboard";
}

async function refreshTokens(refreshToken: string): Promise<StoredTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const res = await fetch("/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const tokens = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  const stored: StoredTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: nowSeconds() + tokens.expires_in - 30,
  };
  writeTokens(stored);
  return stored;
}

async function accessToken(): Promise<string | null> {
  let tokens = readTokens();
  if (!tokens) return null;
  if (tokens.expires_at <= nowSeconds()) {
    tokens = await refreshTokens(tokens.refresh_token);
    if (!tokens) {
      signOut();
      return null;
    }
  }
  return tokens.access_token;
}

// ── API surface ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "not signed in");
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body["message"] === "string" ? body["message"] : `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export interface BillingStatus {
  plan: "premium" | "admin" | null;
  status: string | null;
  current_period_end: number | null;
  quota: number | null;
  used_this_month: number | null;
}

export interface UserInfo {
  email?: string;
  username?: string;
}

export interface ApiKeySummary {
  prefix: string;
  label: string;
  created_at: number;
}

export interface SessionTask {
  id: string;
  title: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  note?: string;
  started_at?: number;
  finished_at?: number;
}

export interface SessionChatMessage {
  role: "agent" | "user" | "system";
  text: string;
  ts: number;
}

export interface SessionRecord {
  id: string;
  url: string;
  status: "queued" | "running" | "completed" | "failed";
  brief?: { angle: string; length_s: number; aspect: string; message: string };
  tasks: SessionTask[];
  chat: SessionChatMessage[];
  render_id?: string;
  video_url?: string;
  error?: string;
  created_at: number;
  updated_at: number;
}

export interface SessionListEntry {
  id: string;
  url: string;
  status: SessionRecord["status"];
  created_at: number;
}

export const api = {
  me: () => apiFetch<{ data?: UserInfo } & UserInfo>("/v3/users/me"),
  billingStatus: () => apiFetch<BillingStatus>("/v1/billing/status"),
  startCheckout: () =>
    apiFetch<{ checkout_url: string }>("/v1/billing/checkout", { method: "POST" }),
  listKeys: () => apiFetch<{ keys: ApiKeySummary[] }>("/v1/keys"),
  createKey: (label: string) =>
    apiFetch<{ api_key: string; label: string }>("/v1/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    }),
  revokeKey: (prefix: string) =>
    apiFetch<{ revoked: boolean }>(`/v1/keys/${encodeURIComponent(prefix)}`, {
      method: "DELETE",
    }),
  createSession: (url: string) =>
    apiFetch<{ session_id: string; session_url: string }>("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  getSession: (id: string) => apiFetch<SessionRecord>(`/v1/sessions/${encodeURIComponent(id)}`),
  listSessions: () => apiFetch<{ sessions: SessionListEntry[] }>("/v1/sessions"),
};
