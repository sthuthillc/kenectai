/**
 * Session HTTP surface:
 *
 *   POST /v1/sessions          {url} → {session_id, session_url} + background run
 *   GET  /v1/sessions          → the caller's session list
 *   GET  /v1/sessions/:id      → full session record (tasks/chat/render/video)
 *
 * Auth reuses the caller-identity chain from billing.ts (Bearer JWT or
 * per-user kn_ key or admin key); a session belongs to the identity that
 * created it, and only that identity (or an admin) can read it.
 */

import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { CallerIdentity } from "../billing.js";
import type { JsonStoreLike } from "../oauthServer.js";
import { InteractionsClient } from "./interactions.js";
import { SkillLoader } from "./skillLoader.js";
import {
  createSessionRecord,
  resolveCliPath,
  SessionEngine,
  type SessionDeps,
} from "./orchestrator.js";
import {
  sessionKey,
  userSessionsKey,
  type SessionRecord,
  type UserSessionsIndex,
} from "./types.js";

export interface SessionRoutesDeps {
  store: JsonStoreLike;
  geminiApiKey: string;
  geminiModel: string;
  appBaseUrl: string;
  resolveIdentity: (headers: Headers) => Promise<CallerIdentity | null>;
  dispatchRender: SessionDeps["dispatchRender"];
  readRenderStatus: SessionDeps["readRenderStatus"];
  /** Test seam: intercept engine construction/launch. */
  launchSession?: (record: SessionRecord) => void;
  log?: (message: string) => void;
}

export function registerSessionRoutes(app: Hono, deps: SessionRoutesDeps): void {
  const skills = lazySkills(deps.log);

  const launch =
    deps.launchSession ??
    ((record: SessionRecord) => {
      const loader = skills();
      if (!loader) return; // startSession already reported the misconfig
      const interactions = new InteractionsClient({
        apiKey: deps.geminiApiKey,
        model: deps.geminiModel,
        usageSink: {
          record(usage) {
            record.usage.calls += 1;
            record.usage.input_tokens += usage.input_tokens;
            record.usage.output_tokens += usage.output_tokens;
          },
        },
      });
      const engine = new SessionEngine(record, {
        store: deps.store,
        skills: loader,
        interactions,
        dispatchRender: deps.dispatchRender,
        readRenderStatus: deps.readRenderStatus,
        cliPath: resolveCliPath(),
        geminiApiKey: deps.geminiApiKey,
        liteModel: process.env["KENECT_GEMINI_LITE_MODEL"]?.trim() || undefined,
        log: deps.log,
      });
      void engine.runAll();
    });

  app.post("/v1/sessions", async (c) => {
    const identity = await deps.resolveIdentity(c.req.raw.headers);
    const userId = identity?.userId ?? (identity?.kind === "admin" ? "admin" : null);
    if (!userId) return c.json({ message: "sessions require a signed-in user or API key" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const url = typeof body["url"] === "string" ? body["url"] : "";
    if (!url.startsWith("https://")) {
      return c.json({ message: "url is required and must be an HTTPS URL" }, 400);
    }
    if (!skills()) {
      return c.json(
        { message: "sessions are not available on this deployment (skills dir missing)" },
        501,
      );
    }
    const id = `ses_${randomUUID().replaceAll("-", "")}`;
    const record = await createSessionRecord(deps.store, { id, userId, url });
    launch(record);
    return c.json(
      {
        session_id: id,
        status: record.status,
        session_url: `${deps.appBaseUrl}/sessions/${id}`,
      },
      202,
    );
  });

  app.get("/v1/sessions", async (c) => {
    const identity = await deps.resolveIdentity(c.req.raw.headers);
    const userId = identity?.userId ?? (identity?.kind === "admin" ? "admin" : null);
    if (!userId) return c.json({ message: "unauthorized" }, 401);
    const index = (await deps.store.read<UserSessionsIndex>(userSessionsKey(userId))) ?? {
      sessions: [],
    };
    return c.json(index);
  });

  app.get("/v1/sessions/:id", async (c) => {
    const identity = await deps.resolveIdentity(c.req.raw.headers);
    const userId = identity?.userId ?? (identity?.kind === "admin" ? "admin" : null);
    if (!userId) return c.json({ message: "unauthorized" }, 401);
    const record = await deps.store.read<SessionRecord>(sessionKey(c.req.param("id")));
    if (!record) return c.json({ message: "session not found" }, 404);
    if (record.user_id !== userId && identity?.kind !== "admin") {
      return c.json({ message: "session not found" }, 404);
    }
    return c.json(record);
  });
}

/** SkillLoader constructed once, lazily; null (with one log line) when the
 * skills directory isn't shipped in this deployment. */
function lazySkills(log?: (m: string) => void): () => SkillLoader | null {
  let cached: SkillLoader | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = new SkillLoader();
    } catch (err) {
      log?.(`sessions disabled: ${(err as Error).message}`);
      cached = null;
    }
    return cached;
  };
}
