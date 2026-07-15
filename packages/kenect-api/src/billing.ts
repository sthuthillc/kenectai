/**
 * Billing for the KENECT AI product API: Stripe subscription checkout,
 * webhook processing, per-user API keys, and monthly render-quota
 * enforcement.
 *
 * Same philosophy as gemini.ts / oauthServer.ts — hand-written REST against
 * api.stripe.com over fetch (form-encoded), zero SDK dependency, all state
 * in the existing GCS JsonStore:
 *
 *   billing/{userId}.json            → subscription status for a user
 *   stripe_customers/{customerId}.json → reverse index customer → user
 *   api_keys/{sha256(key)}.json      → per-user API key record
 *   user_keys/{userId}.json          → list of a user's key prefixes
 *   usage/{userId}/{YYYY-MM}.json    → renders consumed this month
 *
 * Mode (test vs live) is decided entirely by which secret key / price id /
 * webhook secret are configured in env — the code is identical for both.
 */

import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { JsonStoreLike } from "./oauthServer.js";
import { resolveBearerIdentity } from "./oauthServer.js";

const STRIPE_API_BASE = "https://api.stripe.com";
const WEBHOOK_TOLERANCE_SECONDS = 300;
/** Renders included in the premium plan per calendar month. */
export const PLAN_MONTHLY_RENDERS = 300;
/** Grace period after a period lapses before access is cut (webhook delivery slack). */
const PERIOD_END_GRACE_SECONDS = 24 * 60 * 60;

export interface BillingEnv {
  /** sk_test_... or sk_live_... — decides the Stripe mode. Empty = billing routes return 501. */
  stripeSecretKey: string;
  /** whsec_... for the /v1/billing/webhook endpoint. */
  stripeWebhookSecret: string;
  /** The price id (price_...) of the premium subscription plan. */
  stripePriceId: string;
  jwtSecret: string;
  /** Static admin keys (Secret Manager list) — bypass billing entirely. */
  apiKeys: string[];
  appBaseUrl: string;
}

export interface CallerIdentity {
  kind: "admin" | "user";
  userId?: string;
  email?: string;
}

interface BillingRecord {
  user_id: string;
  email: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  current_period_end: number;
  updated_at: number;
}

interface ApiKeyRecord {
  user_id: string;
  email: string;
  label: string;
  created_at: number;
}

interface UserKeysIndex {
  keys: Array<{ prefix: string; hash: string; label: string; created_at: number }>;
}

/** Thrown by quota/identity checks; server.ts maps it onto an HTTP response. */
export class BillingError extends Error {
  constructor(
    readonly status: 401 | 402 | 501,
    message: string,
  ) {
    super(message);
  }
}

// --- helpers -----------------------------------------------------------------

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function monthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function billingKey(userId: string): string {
  return `billing/${userId}.json`;
}

function customerIndexKey(customerId: string): string {
  return `stripe_customers/${customerId}.json`;
}

function apiKeyKey(hash: string): string {
  return `api_keys/${hash}.json`;
}

function userKeysKey(userId: string): string {
  return `user_keys/${userId}.json`;
}

function usageKey(userId: string, month = monthKey()): string {
  return `usage/${userId}/${month}.json`;
}

/** Minimal form-encoder supporting Stripe's bracketed nested-key convention. */
function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function stripeRequest(
  env: BillingEnv,
  method: "GET" | "POST",
  path: string,
  fields?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.stripeSecretKey}`,
      ...(fields ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: fields ? formEncode(fields) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body["error"] as { message?: string } | undefined;
    throw new Error(
      `Stripe ${method} ${path} → HTTP ${res.status}: ${error?.message ?? "unknown error"}`,
    );
  }
  return body;
}

function requireStripe(env: BillingEnv): void {
  if (!env.stripeSecretKey || !env.stripePriceId) {
    throw new BillingError(501, "Stripe billing is not configured on this deployment");
  }
}

// --- webhook signature -------------------------------------------------------

/**
 * Verify a `Stripe-Signature` header (t=...,v1=...) against the raw body per
 * https://docs.stripe.com/webhooks/signatures — HMAC-SHA256 of "{t}.{payload}"
 * with the whsec key, constant-time compare, 5-minute tolerance.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  webhookSecret: string,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!signatureHeader || !webhookSecret) return false;
  const parts = new Map<string, string[]>();
  for (const segment of signatureHeader.split(",")) {
    const eq = segment.indexOf("=");
    if (eq < 1) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds() - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  for (const candidate of parts.get("v1") ?? []) {
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

// --- identity ----------------------------------------------------------------

/**
 * Resolve the caller across all three credential kinds:
 *   1. Bearer JWT (OAuth login)            → user identity
 *   2. Per-user API key (kn_..., hashed)   → user identity
 *   3. Static admin key (Secret Manager)   → admin (bypasses billing)
 * Returns null when nothing matches (caller is unauthenticated).
 */
export async function resolveCallerIdentity(
  headers: Headers,
  env: BillingEnv,
  store: JsonStoreLike,
): Promise<CallerIdentity | null> {
  const bearer = resolveBearerIdentity(headers.get("authorization"), env.jwtSecret);
  if (bearer) return { kind: "user", userId: bearer.userId, email: bearer.email };

  const apiKey =
    headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!apiKey) return null;

  if (apiKey.startsWith("kn_")) {
    const record = await store.read<ApiKeyRecord>(apiKeyKey(sha256Hex(apiKey)));
    if (record) return { kind: "user", userId: record.user_id, email: record.email };
    return null;
  }
  if (env.apiKeys.includes(apiKey)) return { kind: "admin" };
  return null;
}

// --- quota -------------------------------------------------------------------

/**
 * Gate a paid action: admins pass free; users need an active subscription and
 * remaining monthly quota. Consumes one render from the month's counter on
 * success. Throws BillingError(402) otherwise.
 */
export async function checkAndConsumeQuota(
  identity: CallerIdentity,
  store: JsonStoreLike,
): Promise<void> {
  if (identity.kind === "admin") return;
  const userId = identity.userId;
  if (!userId) throw new BillingError(401, "unauthorized");

  const billing = await store.read<BillingRecord>(billingKey(userId));
  const active =
    billing &&
    (billing.status === "active" || billing.status === "trialing") &&
    billing.current_period_end + PERIOD_END_GRACE_SECONDS > nowSeconds();
  if (!active) {
    throw new BillingError(
      402,
      "No active KENECT AI subscription. Start one via POST /v1/billing/checkout.",
    );
  }

  const usage = (await store.read<{ count: number }>(usageKey(userId))) ?? { count: 0 };
  if (usage.count >= PLAN_MONTHLY_RENDERS) {
    throw new BillingError(
      402,
      `Monthly quota of ${PLAN_MONTHLY_RENDERS} renders reached. Quota resets at the start of next month (UTC).`,
    );
  }
  await store.write(usageKey(userId), { count: usage.count + 1 });
}

// --- webhook event handling ----------------------------------------------------

async function upsertBillingFromSubscription(
  store: JsonStoreLike,
  userId: string,
  email: string,
  subscription: Record<string, unknown>,
): Promise<void> {
  const record: BillingRecord = {
    user_id: userId,
    email,
    stripe_customer_id: String(subscription["customer"] ?? ""),
    stripe_subscription_id: String(subscription["id"] ?? ""),
    status: String(subscription["status"] ?? "unknown"),
    current_period_end: Number(subscription["current_period_end"] ?? 0),
    updated_at: nowSeconds(),
  };
  await store.write(billingKey(userId), record);
  if (record.stripe_customer_id) {
    await store.write(customerIndexKey(record.stripe_customer_id), {
      user_id: userId,
      email,
    });
  }
}

async function handleWebhookEvent(
  env: BillingEnv,
  store: JsonStoreLike,
  event: Record<string, unknown>,
): Promise<void> {
  const type = String(event["type"] ?? "");
  const data = event["data"] as { object?: Record<string, unknown> } | undefined;
  const object = data?.object;
  if (!object) return;

  if (type === "checkout.session.completed") {
    const userId = String(object["client_reference_id"] ?? "");
    const email = String(
      (object["customer_details"] as { email?: string } | undefined)?.email ??
        object["customer_email"] ??
        "",
    );
    const subscriptionId = String(object["subscription"] ?? "");
    if (!userId || !subscriptionId) return;
    const subscription = await stripeRequest(env, "GET", `/v1/subscriptions/${subscriptionId}`);
    await upsertBillingFromSubscription(store, userId, email, subscription);
    return;
  }

  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") {
    const customerId = String(object["customer"] ?? "");
    if (!customerId) return;
    const index = await store.read<{ user_id: string; email: string }>(
      customerIndexKey(customerId),
    );
    if (!index) return; // subscription for a customer we never checked out — not ours to track
    await upsertBillingFromSubscription(store, index.user_id, index.email, object);
  }
}

// --- routes --------------------------------------------------------------------

export function registerBillingRoutes(app: Hono, env: BillingEnv, store: JsonStoreLike): void {
  // Start a subscription. Requires a signed-in user (Bearer JWT) — the key
  // links the Stripe customer to the user record.
  app.post("/v1/billing/checkout", async (c) => {
    requireStripe(env);
    const identity = resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret);
    if (!identity) {
      return c.json({ message: "checkout requires a signed-in user (Bearer token)" }, 401);
    }
    const session = await stripeRequest(env, "POST", "/v1/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": env.stripePriceId,
      "line_items[0][quantity]": "1",
      client_reference_id: identity.userId,
      customer_email: identity.email,
      "subscription_data[metadata][user_id]": identity.userId,
      success_url: `${env.appBaseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.appBaseUrl}/billing/cancelled`,
    });
    return c.json({ checkout_url: session["url"], session_id: session["id"] });
  });

  // Current plan + this month's usage, for the CLI/dashboard.
  app.get("/v1/billing/status", async (c) => {
    const identity = await resolveCallerIdentity(c.req.raw.headers, env, store);
    if (!identity) return c.json({ message: "unauthorized" }, 401);
    if (identity.kind === "admin") {
      return c.json({ plan: "admin", quota: null, used_this_month: null });
    }
    const billing = await store.read<BillingRecord>(billingKey(identity.userId!));
    const usage = (await store.read<{ count: number }>(usageKey(identity.userId!))) ?? {
      count: 0,
    };
    return c.json({
      plan:
        billing && (billing.status === "active" || billing.status === "trialing")
          ? "premium"
          : null,
      status: billing?.status ?? null,
      current_period_end: billing?.current_period_end ?? null,
      quota: PLAN_MONTHLY_RENDERS,
      used_this_month: usage.count,
    });
  });

  // Stripe webhook — public route, authenticated by signature instead of API key.
  app.post("/v1/billing/webhook", async (c) => {
    if (!env.stripeWebhookSecret) {
      return c.json({ message: "webhook secret not configured" }, 501);
    }
    const rawBody = await c.req.text();
    const valid = verifyStripeSignature(
      rawBody,
      c.req.header("stripe-signature"),
      env.stripeWebhookSecret,
    );
    if (!valid) return c.json({ message: "invalid signature" }, 400);
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ message: "invalid JSON" }, 400);
    }
    await handleWebhookEvent(env, store, event);
    return c.json({ received: true });
  });

  // Issue a per-user API key (shown once; only the hash is stored).
  app.post("/v1/keys", async (c) => {
    const identity = resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret);
    if (!identity) {
      return c.json({ message: "key creation requires a signed-in user (Bearer token)" }, 401);
    }
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown };
    const label =
      typeof body.label === "string" && body.label.trim() ? body.label.trim() : "default";
    const key = `kn_${randomBytes(24).toString("hex")}`;
    const hash = sha256Hex(key);
    const created: ApiKeyRecord = {
      user_id: identity.userId,
      email: identity.email,
      label,
      created_at: nowSeconds(),
    };
    await store.write(apiKeyKey(hash), created);
    const index = (await store.read<UserKeysIndex>(userKeysKey(identity.userId))) ?? { keys: [] };
    index.keys.push({ prefix: key.slice(0, 10), hash, label, created_at: created.created_at });
    await store.write(userKeysKey(identity.userId), index);
    return c.json({ api_key: key, label, note: "Store this now — it is not shown again." });
  });

  // List the caller's keys (prefixes only).
  app.get("/v1/keys", async (c) => {
    const identity = resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret);
    if (!identity) return c.json({ message: "unauthorized" }, 401);
    const index = (await store.read<UserKeysIndex>(userKeysKey(identity.userId))) ?? { keys: [] };
    return c.json({
      keys: index.keys.map((k) => ({ prefix: k.prefix, label: k.label, created_at: k.created_at })),
    });
  });

  // Revoke a key by its prefix.
  app.delete("/v1/keys/:prefix", async (c) => {
    const identity = resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret);
    if (!identity) return c.json({ message: "unauthorized" }, 401);
    const prefix = c.req.param("prefix");
    const index = (await store.read<UserKeysIndex>(userKeysKey(identity.userId))) ?? { keys: [] };
    const entry = index.keys.find((k) => k.prefix === prefix);
    if (!entry) return c.json({ message: "key not found" }, 404);
    await store.delete(apiKeyKey(entry.hash));
    index.keys = index.keys.filter((k) => k.prefix !== prefix);
    await store.write(userKeysKey(identity.userId), index);
    return c.json({ revoked: true });
  });
}
