/**
 * A thin MCP (Model Context Protocol) server in front of the existing
 * Gemini-backed product endpoints. The intelligence lives entirely in
 * kenect-api's REST routes (`/v1/products/*`, `/v3/kenectai/renders/*`) —
 * this file adds no new business logic, it only exposes a handful of loose,
 * natural-language-friendly tools that forward to those routes via Hono's
 * in-process `app.request()` (no real network hop) and reuses the SAME
 * global auth middleware in server.ts by forwarding whatever credential the
 * caller sent.
 *
 * Mounted at `POST /mcp` (also handles GET/DELETE per the Streamable HTTP
 * spec). One `McpServer` + transport is built per request in stateless mode
 * (`sessionIdGenerator: undefined`) — Cloud Run instances aren't guaranteed
 * to be the same between requests, so there's no in-memory session state to
 * keep consistent.
 */

import type { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const SERVER_VERSION = "1.0.0";

interface CallerAuth {
  authorization: string | null;
  apiKey: string | null;
}

function forwardedHeaders(
  auth: CallerAuth,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (auth.authorization) headers["authorization"] = auth.authorization;
  if (auth.apiKey) headers["x-api-key"] = auth.apiKey;
  return headers;
}

/** Calls a kenect-api route in-process (no network hop) and returns the parsed JSON body + ok flag. */
async function callInternalRoute(
  app: Hono,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await app.request(path, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = { message: await res.text().catch(() => res.statusText) };
  }
  return { ok: res.ok, status: res.status, body };
}

function toolTextResult(result: { ok: boolean; status: number; body: unknown }) {
  if (!result.ok) {
    const message =
      typeof result.body === "object" && result.body !== null && "message" in result.body
        ? String((result.body as { message: unknown }).message)
        : `HTTP ${result.status}`;
    return {
      content: [{ type: "text" as const, text: `Error (${result.status}): ${message}` }],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(result.body, null, 2) }] };
}

function buildMcpServer(app: Hono, auth: CallerAuth): McpServer {
  const server = new McpServer({ name: "kenectai", version: SERVER_VERSION });

  server.registerTool(
    "create_video_from_url",
    {
      title: "Create a video from a website URL",
      description:
        'Produce a studio-quality product launch promo from a website URL: real browser capture of the brand, a storyboarded multi-scene composition, narrated voiceover, background music, and captions (the product-launch-video workflow, run autonomously). Takes ~10-20 minutes; returns a session_id — poll with get_video_status. Pass mode:"fast" for the legacy single-scene silent video (~5 min, lower quality).',
      inputSchema: {
        url: z.string().url().describe("The HTTPS URL of the product website to turn into a video"),
        mode: z
          .enum(["studio", "fast"])
          .optional()
          .describe(
            '"studio" (default): full narrated multi-scene pipeline. "fast": legacy single-shot silent video.',
          ),
        duration_seconds: z
          .number()
          .min(8)
          .max(60)
          .optional()
          .describe("(fast mode only) Target video length in seconds (default 20)"),
        title: z.string().optional().describe("(fast mode only) Optional title override"),
      },
    },
    async ({ url, mode, duration_seconds, title }) => {
      if (mode === "fast") {
        const result = await callInternalRoute(app, "/v1/products/website-video", {
          method: "POST",
          headers: forwardedHeaders(auth, { "content-type": "application/json" }),
          body: JSON.stringify({ url, duration_s: duration_seconds, title }),
        });
        return toolTextResult(result);
      }
      const result = await callInternalRoute(app, "/v1/sessions", {
        method: "POST",
        headers: forwardedHeaders(auth, { "content-type": "application/json" }),
        body: JSON.stringify({ url }),
      });
      return toolTextResult(result);
    },
  );

  server.registerTool(
    "create_frame_pack",
    {
      title: "Create a brand frame-pack from a text brief",
      description:
        "Generate a KENECT AI 'frame pack' — design tokens, a showcase video composition, and a README — from a written product or brand brief (no URL needed). Returns a job_id and a signed download_url for the zip.",
      inputSchema: {
        source_text: z
          .string()
          .min(20)
          .describe("A written brief describing the product or brand (at least 20 characters)"),
      },
    },
    async ({ source_text }) => {
      const result = await callInternalRoute(app, "/v1/products/frame-pack", {
        method: "POST",
        headers: forwardedHeaders(auth, { "content-type": "application/json" }),
        body: JSON.stringify({ source_text }),
      });
      return toolTextResult(result);
    },
  );

  server.registerTool(
    "get_video_status",
    {
      title: "Check the status of a video job",
      description:
        "Poll a session_id (ses_..., studio pipeline: reports the live step-by-step task board, then the signed video URL) or a render_id (hf-render-..., fast mode) returned by create_video_from_url.",
      inputSchema: {
        render_id: z
          .string()
          .describe("The session_id (ses_...) or render_id returned by create_video_from_url"),
      },
    },
    async ({ render_id }) => {
      const path = render_id.startsWith("ses_")
        ? `/v1/sessions/${encodeURIComponent(render_id)}`
        : `/v3/kenectai/renders/${encodeURIComponent(render_id)}`;
      const result = await callInternalRoute(app, path, {
        method: "GET",
        headers: forwardedHeaders(auth),
      });
      return toolTextResult(result);
    },
  );

  return server;
}

/** Mounts the MCP endpoint at `/mcp` on the given app. Call after all other routes are registered. */
export function registerMcpRoutes(app: Hono): void {
  app.all("/mcp", async (c) => {
    const auth: CallerAuth = {
      authorization: c.req.header("authorization") ?? null,
      apiKey: c.req.header("x-api-key") ?? null,
    };
    const server = buildMcpServer(app, auth);
    // Stateless (no session) + plain JSON responses: each tool call here resolves
    // in one shot (it's a thin forward to an existing REST route), so there's
    // nothing to stream — SSE would only add client-side complexity for no benefit.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
}
