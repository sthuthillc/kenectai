/**
 * Chain resolver for KENECT AI credentials.
 *
 * Priority — first non-empty wins:
 *   1. `KENECT_API_KEY` env
 *   2. `~/.kenectai/credentials` (JSON) — unexpired OAuth, else api_key
 *
 * Absent sources fall through. A broken file (parse error, bad shape)
 * surfaces immediately as `ErrInvalidStore` — silently falling back
 * would mask user config bugs.
 *
 * Expiry policy: an OAuth access_token whose `expires_at` is in the
 * past (60s skew) is considered expired. If a `refresh_token` is also
 * present, callers can still use it via `refreshable: true`. Otherwise
 * the api_key (if any) wins.
 */

import { isHeaderSafe, readStore } from "./store.js";
import { ErrInvalidStore, ErrNotConfigured, isAuthError } from "./errors.js";

type CredentialSource = "env" | "file_json" | "file_legacy";

interface ApiKeyCredential {
  type: "api_key";
  key: string;
  source: CredentialSource;
}

interface OAuthCredential {
  type: "oauth";
  access_token: string;
  refresh_token?: string;
  expires_at?: Date;
  scope?: string;
  source: CredentialSource;
  /** True when the access_token is expired but a refresh_token exists. */
  refreshable: boolean;
}

export type ResolvedCredential = ApiKeyCredential | OAuthCredential;

const EXPIRY_SKEW_MS = 60 * 1000;

export interface ResolveOptions {
  now?: () => Date;
}

export async function resolveCredential(opts: ResolveOptions = {}): Promise<ResolvedCredential> {
  const now = (opts.now ?? (() => new Date()))();

  const kenectEnv = process.env["KENECT_API_KEY"];
  if (kenectEnv && kenectEnv.length > 0) {
    if (!isHeaderSafe(kenectEnv)) {
      throw ErrInvalidStore("KENECT_API_KEY contains control characters");
    }
    return { type: "api_key", key: kenectEnv, source: "env" };
  }

  const { credentials, source } = await readStore();
  if (source === "absent") throw ErrNotConfigured();

  const fileSource: CredentialSource = source === "file_legacy" ? "file_legacy" : "file_json";

  if (credentials.oauth) {
    const oauth = pickOAuth(credentials.oauth, now, fileSource);
    if (oauth) return oauth;
  }
  if (credentials.api_key) {
    return { type: "api_key", key: credentials.api_key, source: fileSource };
  }
  throw ErrNotConfigured();
}

/** Like `resolveCredential` but returns `null` instead of throwing `NOT_CONFIGURED`. */
export async function tryResolveCredential(
  opts: ResolveOptions = {},
): Promise<ResolvedCredential | null> {
  try {
    return await resolveCredential(opts);
  } catch (err) {
    if (isAuthError(err) && err.code === "NOT_CONFIGURED") {
      return null;
    }
    throw err;
  }
}

function pickOAuth(
  tokens: NonNullable<Awaited<ReturnType<typeof readStore>>["credentials"]["oauth"]>,
  now: Date,
  source: CredentialSource,
): OAuthCredential | null {
  const expiresAt = parseDate(tokens.expires_at);
  const expired = expiresAt !== undefined && expiresAt.getTime() - EXPIRY_SKEW_MS < now.getTime();

  if (expired && !tokens.refresh_token) return null;

  const out: OAuthCredential = {
    type: "oauth",
    access_token: tokens.access_token,
    source,
    refreshable: expired && tokens.refresh_token !== undefined,
  };
  if (tokens.refresh_token) out.refresh_token = tokens.refresh_token;
  if (expiresAt) out.expires_at = expiresAt;
  if (tokens.scope) out.scope = tokens.scope;
  return out;
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
