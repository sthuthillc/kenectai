import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import AdmZip from "adm-zip";
import { Storage } from "@google-cloud/storage";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import {
  getRenderProgress,
  renderToCloudRun,
  type SerializableDistributedRenderConfig,
} from "@kenectai/gcp-cloud-run/sdk";
import { registerOAuthRoutes, resolveBearerIdentity } from "./oauthServer.js";
import { GeminiClient, GeminiError } from "./gemini.js";
import { generateFramePack } from "./products/framePack.js";
import { CompositionLintError, generateWebsiteComposition } from "./products/websiteVideo.js";

const ZIP_CONTENT_TYPE = "application/zip";
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const RENDER_FORMATS = ["mp4", "webm", "mov"] as const;
const RENDER_QUALITIES = ["draft", "standard", "high"] as const;
const RENDER_RESOLUTIONS = ["1080p", "4k"] as const;
const RENDER_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

export interface KenectApiEnv {
  apiBaseUrl: string;
  appBaseUrl: string;
  uploadBucket: string;
  renderBucket: string;
  projectId: string;
  renderLocation: string;
  renderWorkflowId: string;
  renderServiceUrl: string;
  apiKeys: string[];
  jwtSecret: string;
  geminiApiKey: string;
  geminiModel: string;
}

type RenderStatus = "queued" | "rendering" | "completed" | "failed";
type RenderFormat = "mp4" | "webm" | "mov";
type RenderQuality = "draft" | "standard" | "high";
type RenderResolution = "1080p" | "4k";
type RenderAspectRatio = "16:9" | "9:16" | "1:1";
type ApiErrorStatus = 400 | 401 | 404 | 409 | 413 | 422 | 501 | 502;

interface RenderRecord {
  render_id: string;
  execution_name: string;
  output_gcs_uri: string;
  project_gcs_uri: string;
  title: string | null;
  callback_id: string | null;
  callback_url: string | null;
  fps: 24 | 30 | 60;
  format: RenderFormat;
  quality: RenderQuality;
  resolution: RenderResolution;
  aspect_ratio: RenderAspectRatio;
  composition: string;
  variables: Record<string, unknown> | null;
  created_at: number;
  deleted_at?: number;
}

interface CreateRenderRequest {
  project: ProjectInput;
  fps?: number | null;
  quality?: RenderQuality | null;
  format?: RenderFormat | null;
  resolution?: RenderResolution | null;
  aspect_ratio?: RenderAspectRatio | null;
  composition?: string | null;
  variables?: Record<string, unknown> | null;
  title?: string | null;
  callback_id?: string | null;
  callback_url?: string | null;
}

type ProjectInput =
  | { type: "asset_id"; asset_id: string }
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string };

interface PublishedProjectResponse {
  project_id: string;
  title: string;
  file_count: number;
  url: string;
  claim_token: string;
}

function loadEnv(): KenectApiEnv {
  const renderBucket = requiredEnv("KENECT_RENDER_BUCKET");
  return {
    apiBaseUrl: env("KENECT_API_BASE_URL", "https://api.kenectai.com"),
    appBaseUrl: env("KENECT_APP_BASE_URL", "https://app.kenectai.com"),
    uploadBucket: env("KENECT_UPLOAD_BUCKET", renderBucket),
    renderBucket,
    projectId: env("KENECT_GCP_PROJECT", env("GOOGLE_CLOUD_PROJECT", "")),
    renderLocation: env("KENECT_RENDER_LOCATION", "us-central1"),
    renderWorkflowId: requiredEnv("KENECT_RENDER_WORKFLOW_ID"),
    renderServiceUrl: requiredEnv("KENECT_RENDER_SERVICE_URL"),
    apiKeys: splitCsv(process.env["KENECT_API_KEYS"]),
    jwtSecret: requiredEnv("KENECT_JWT_SECRET"),
    geminiApiKey: env("GEMINI_API_KEY", ""),
    geminiModel: env("KENECT_GEMINI_MODEL", "gemini-2.5-flash"),
  };
}

/** Product routes (frame-pack, website-video) need Gemini; other routes don't require it to boot. */
function requireGemini(env: KenectApiEnv): GeminiClient {
  if (!env.geminiApiKey) {
    throw new HttpError(501, "GEMINI_API_KEY is not configured on this deployment");
  }
  return new GeminiClient({ apiKey: env.geminiApiKey, model: env.geminiModel });
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new HttpError(400, `${name} is required`);
  return value;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function data<T>(payload: T): { data: T } {
  return { data: payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function enumField<T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] | null {
  const value = stringField(record, key);
  return value && (values as readonly string[]).includes(value) ? (value as T[number]) : null;
}

function assetKey(assetId: string): string {
  return `assets/${assetId}/project.zip`;
}

function renderRecordKey(renderId: string): string {
  return `render-records/${renderId}.json`;
}

function productJobKey(product: string, jobId: string): string {
  return `product-jobs/${product}/${jobId}.json`;
}

function publishedUploadKey(uploadKey: string): string {
  return `publish-uploads/${uploadKey}.zip`;
}

function outputKeyFromGcsUri(uri: string): { bucket: string; key: string } {
  if (!uri.startsWith("gs://")) throw new Error(`Expected gs:// URI, got ${uri}`);
  const withoutScheme = uri.slice("gs://".length);
  const slash = withoutScheme.indexOf("/");
  if (slash < 1) throw new Error(`Malformed GCS URI: ${uri}`);
  return { bucket: withoutScheme.slice(0, slash), key: withoutScheme.slice(slash + 1) };
}

function dimensionsFor(
  resolution: RenderResolution,
  aspectRatio: RenderAspectRatio,
): { width: number; height: number } {
  const scale = resolution === "4k" ? 2 : 1;
  switch (aspectRatio) {
    case "16:9":
      return { width: 1920 * scale, height: 1080 * scale };
    case "9:16":
      return { width: 1080 * scale, height: 1920 * scale };
    case "1:1":
      return { width: 1080 * scale, height: 1080 * scale };
  }
}

function parseFps(value: number | null | undefined): 24 | 30 | 60 {
  const fps = value ?? 30;
  if (fps === 24 || fps === 30 || fps === 60) return fps;
  throw new HttpError(400, "fps must be one of 24, 30, or 60 for Kenect GCP renders");
}

function renderConfigFromRequest(req: CreateRenderRequest): SerializableDistributedRenderConfig {
  const fps = parseFps(req.fps);
  const format = req.format ?? "mp4";
  const resolution = req.resolution ?? "1080p";
  const aspectRatio = req.aspect_ratio ?? "16:9";
  const { width, height } = dimensionsFor(resolution, aspectRatio);
  return {
    fps,
    width,
    height,
    format,
    quality: req.quality ?? "standard",
    hdrMode: "force-sdr",
    variables: req.variables ?? undefined,
  };
}

function parseProjectInput(value: unknown): ProjectInput {
  if (!isRecord(value)) throw new HttpError(400, "project must be an object");
  const type = stringField(value, "type");
  if (type === "asset_id") {
    const assetId = stringField(value, "asset_id");
    if (!assetId) throw new HttpError(400, "project.asset_id is required");
    return { type, asset_id: assetId };
  }
  if (type === "url") {
    const url = stringField(value, "url");
    if (!url || !url.startsWith("https://")) {
      throw new HttpError(400, "project.url must be an HTTPS URL");
    }
    return { type, url };
  }
  if (type === "base64") {
    const mediaType = stringField(value, "media_type");
    const data = stringField(value, "data");
    if (!mediaType || !data) {
      throw new HttpError(400, "project.media_type and project.data are required");
    }
    return { type, media_type: mediaType, data };
  }
  throw new HttpError(400, 'project.type must be "asset_id", "url", or "base64"');
}

function parseCreateRenderRequest(body: Record<string, unknown>): CreateRenderRequest {
  const variables = recordField(body, "variables");
  return {
    project: parseProjectInput(body["project"]),
    fps: numberField(body, "fps"),
    quality: enumField(body, "quality", RENDER_QUALITIES),
    format: enumField(body, "format", RENDER_FORMATS),
    resolution: enumField(body, "resolution", RENDER_RESOLUTIONS),
    aspect_ratio: enumField(body, "aspect_ratio", RENDER_ASPECT_RATIOS),
    composition: stringField(body, "composition"),
    variables,
    title: stringField(body, "title"),
    callback_id: stringField(body, "callback_id"),
    callback_url: stringField(body, "callback_url"),
  };
}

class HttpError extends Error {
  constructor(
    readonly status: ApiErrorStatus,
    message: string,
  ) {
    super(message);
  }
}

class JsonStore {
  constructor(
    private readonly storage: Storage,
    private readonly bucketName: string,
  ) {}

  async write<T>(key: string, value: T): Promise<void> {
    await this.storage
      .bucket(this.bucketName)
      .file(key)
      .save(JSON.stringify(value, null, 2), {
        contentType: "application/json",
        resumable: false,
      });
  }

  async read<T>(key: string): Promise<T | null> {
    const file = this.storage.bucket(this.bucketName).file(key);
    const [exists] = await file.exists();
    if (!exists) return null;
    const [bytes] = await file.download();
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  async list<T>(prefix: string, limit: number): Promise<T[]> {
    const [files] = await this.storage
      .bucket(this.bucketName)
      .getFiles({ prefix, maxResults: limit });
    const out: T[] = [];
    for (const file of files) {
      const [bytes] = await file.download();
      out.push(JSON.parse(bytes.toString("utf8")) as T);
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    await this.storage.bucket(this.bucketName).file(key).delete({ ignoreNotFound: true });
  }
}

function assertAuthorized(headers: Headers, env: KenectApiEnv): void {
  if (env.apiKeys.length === 0) return;
  const apiKey = headers.get("x-api-key");
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const supplied = apiKey || bearer || "";
  if (!env.apiKeys.includes(supplied)) {
    throw new HttpError(401, "unauthorized");
  }
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!isRecord(body)) throw new HttpError(400, "request body must be a JSON object");
    return body;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid JSON request body");
  }
}

function safeZipEntries(zip: AdmZip): void {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    const parts = name.split(/[\\/]/);
    if (name.startsWith("/") || parts.includes("..")) {
      throw new HttpError(400, `zip contains unsafe path: ${name}`);
    }
  }
}

async function materializeProjectZip(
  storage: Storage,
  env: KenectApiEnv,
  project: ProjectInput,
  workdir: string,
): Promise<string> {
  const zipPath = join(workdir, "project.zip");
  if (project.type === "asset_id") {
    await storage.bucket(env.uploadBucket).file(assetKey(project.asset_id)).download({
      destination: zipPath,
    });
  } else if (project.type === "url") {
    const response = await fetch(project.url);
    if (!response.ok) {
      throw new HttpError(400, `failed to download project URL: HTTP ${response.status}`);
    }
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  } else {
    if (project.media_type !== ZIP_CONTENT_TYPE) {
      throw new HttpError(400, `base64 project media_type must be ${ZIP_CONTENT_TYPE}`);
    }
    writeFileSync(zipPath, Buffer.from(project.data, "base64"));
  }

  const projectDir = join(workdir, "project");
  const zip = new AdmZip(zipPath);
  safeZipEntries(zip);
  zip.extractAllTo(projectDir, true);
  return projectDir;
}

async function signedReadUrl(storage: Storage, gcsUri: string): Promise<string> {
  const { bucket, key } = outputKeyFromGcsUri(gcsUri);
  const [url] = await storage
    .bucket(bucket)
    .file(key)
    .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
  return url;
}

function mapProgressStatus(status: string): RenderStatus {
  if (status === "succeeded") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "rendering";
}

function createPublishedResponse(input: {
  projectId: string;
  title: string;
  appBaseUrl: string;
  fileCount?: number;
}): PublishedProjectResponse {
  return {
    project_id: input.projectId,
    title: input.title,
    file_count: input.fileCount ?? 0,
    url: `${input.appBaseUrl.replace(/\/+$/, "")}/p/${input.projectId}`,
    claim_token: `claim_${randomUUID().replaceAll("-", "")}`,
  };
}

export function createKenectApiApp(options?: { env?: KenectApiEnv; storage?: Storage }): Hono {
  const env = options?.env ?? loadEnv();
  if (!env.projectId) throw new Error("KENECT_GCP_PROJECT or GOOGLE_CLOUD_PROJECT is required");
  const storage = options?.storage ?? new Storage();
  const store = new JsonStore(storage, env.renderBucket);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ message: err.message }, err.status);
    }
    console.error(err);
    return c.json({ message: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.use("*", async (c, next) => {
    const path = c.req.path;
    // OAuth routes are pre-authentication by definition (the browser has
    // no API key); health checks stay open for Cloud Run probes.
    const isPublic =
      path === "/healthz" ||
      path === "/v3/healthz" ||
      path === "/favicon.ico" ||
      path === "/favicon.svg" ||
      path.startsWith("/oauth/") ||
      path.startsWith("/v1/oauth/");
    if (!isPublic && !resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret)) {
      assertAuthorized(c.req.raw.headers, env);
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true, service: "kenect-api" }));
  app.get("/v3/healthz", (c) => c.json({ ok: true, service: "kenect-api" }));
  app.get("/favicon.ico", (c) => c.body(null, 204));
  app.get("/favicon.svg", (c) =>
    c.body(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0A0A0F"/><path d="M17 12h10v40H17z" fill="#F6F5F1"/><path d="M31 32 50 12h-13L25 25v14l12 13h13z" fill="#2DD4BF"/></svg>',
      200,
      { "Content-Type": "image/svg+xml; charset=utf-8" },
    ),
  );

  app.get("/v3/users/me", (c) => {
    const identity = resolveBearerIdentity(c.req.header("authorization"), env.jwtSecret);
    if (identity) {
      return c.json(
        data({
          username: identity.email.split("@")[0] ?? identity.email,
          email: identity.email,
          billing_type: "usage_based",
        }),
      );
    }
    return c.json(
      data({
        username: "kenect-cli",
        email: "cli@kenectai.com",
        billing_type: "usage_based",
      }),
    );
  });

  registerOAuthRoutes(app, { env, store, jwtSecret: env.jwtSecret });

  app.post("/v3/assets/direct-uploads", async (c) => {
    const body = await readJsonBody(c);
    const filename = stringField(body, "filename") ?? "project.zip";
    const contentType = stringField(body, "content_type") ?? ZIP_CONTENT_TYPE;
    const sizeBytes = numberField(body, "size_bytes") ?? 0;
    if (contentType !== ZIP_CONTENT_TYPE)
      throw new HttpError(400, "content_type must be application/zip");
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new HttpError(400, "size_bytes must be a positive integer");
    }
    if (sizeBytes > MAX_UPLOAD_BYTES) throw new HttpError(413, "asset exceeds 200 MB upload limit");

    const assetId = `asst_${randomUUID().replaceAll("-", "")}`;
    const file = storage.bucket(env.uploadBucket).file(assetKey(assetId));
    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + SIGNED_URL_TTL_MS,
      contentType,
    });
    await store.write(`assets/${assetId}.json`, {
      asset_id: assetId,
      filename: basename(filename),
      content_type: contentType,
      size_bytes: sizeBytes,
      gcs_key: assetKey(assetId),
      status: "pending_upload",
      created_at: Date.now(),
    });
    return c.json({
      asset_id: assetId,
      upload_url: uploadUrl,
      upload_headers: { "content-type": contentType },
      expires_in_seconds: Math.floor(SIGNED_URL_TTL_MS / 1000),
      max_bytes: MAX_UPLOAD_BYTES,
      status: "pending_upload",
    });
  });

  app.post("/v3/assets/:assetId/complete", async (c) => {
    const assetId = c.req.param("assetId");
    const file = storage.bucket(env.uploadBucket).file(assetKey(assetId));
    const [exists] = await file.exists();
    if (!exists) throw new HttpError(409, "uploaded object not found yet");
    const [metadata] = await file.getMetadata();
    const sizeBytes = Number(metadata.size ?? 0);
    await store.write(`assets/${assetId}.json`, {
      asset_id: assetId,
      mime_type: metadata.contentType ?? ZIP_CONTENT_TYPE,
      size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      gcs_key: assetKey(assetId),
      status: "processing",
      completed_at: Date.now(),
    });
    return c.json({
      asset_id: assetId,
      url: `gs://${env.uploadBucket}/${assetKey(assetId)}`,
      mime_type: metadata.contentType ?? ZIP_CONTENT_TYPE,
      size_bytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
      status: "processing",
    });
  });

  const dispatchRender = async (body: CreateRenderRequest): Promise<{ render_id: string }> => {
    const workdir = mkdtempSync(join(tmpdir(), "kenect-render-"));
    try {
      const projectDir = await materializeProjectZip(storage, env, body.project, workdir);
      const config = renderConfigFromRequest(body);
      const handle = await renderToCloudRun({
        projectDir,
        config,
        bucketName: env.renderBucket,
        projectId: env.projectId,
        location: env.renderLocation,
        workflowId: env.renderWorkflowId,
        serviceUrl: env.renderServiceUrl,
      });
      const record: RenderRecord = {
        render_id: handle.renderId,
        execution_name: handle.executionName,
        output_gcs_uri: handle.outputGcsUri,
        project_gcs_uri: handle.projectGcsUri,
        title: body.title ?? null,
        callback_id: body.callback_id ?? null,
        callback_url: body.callback_url ?? null,
        fps: config.fps,
        format: config.format as RenderFormat,
        quality: body.quality ?? "standard",
        resolution: body.resolution ?? "1080p",
        aspect_ratio: body.aspect_ratio ?? "16:9",
        composition: body.composition ?? "index.html",
        variables: body.variables ?? null,
        created_at: Math.floor(Date.now() / 1000),
      };
      await store.write(renderRecordKey(record.render_id), record);
      return { render_id: record.render_id };
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  };

  const createRenderHandler = async (c: Context) => {
    const body = parseCreateRenderRequest(await readJsonBody(c));
    return c.json(await dispatchRender(body));
  };

  const listRendersHandler = async (c: Context) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(Math.max(Number(limitRaw), 1), 100) : 10;
    const records = (await store.list<RenderRecord>("render-records/", limit)).filter(
      (r) => !r.deleted_at,
    );
    const dataRows = await Promise.all(records.map((record) => renderDetail(storage, record)));
    return c.json({ data: dataRows, has_more: false });
  };

  const getRenderHandler = async (c: Context) => {
    const record = await store.read<RenderRecord>(renderRecordKey(requiredParam(c, "renderId")));
    if (!record || record.deleted_at) throw new HttpError(404, "render not found");
    return c.json(await renderDetail(storage, record));
  };

  const deleteRenderHandler = async (c: Context) => {
    const renderId = requiredParam(c, "renderId");
    const record = await store.read<RenderRecord>(renderRecordKey(renderId));
    if (!record || record.deleted_at) throw new HttpError(404, "render not found");
    await store.write(renderRecordKey(renderId), {
      ...record,
      deleted_at: Math.floor(Date.now() / 1000),
    });
    return c.json({ render_id: renderId });
  };

  app.post("/v3/kenectai/renders", createRenderHandler);
  app.get("/v3/kenectai/renders", listRendersHandler);
  app.get("/v3/kenectai/renders/:renderId", getRenderHandler);
  app.delete("/v3/kenectai/renders/:renderId", deleteRenderHandler);
  app.post("/v3/hyperframes/renders", createRenderHandler);
  app.get("/v3/hyperframes/renders", listRendersHandler);
  app.get("/v3/hyperframes/renders/:renderId", getRenderHandler);
  app.delete("/v3/hyperframes/renders/:renderId", deleteRenderHandler);

  const preparePublishUploadHandler = async (c: Context) => {
    const body = await readJsonBody(c);
    const fileName = stringField(body, "file_name") ?? "project.zip";
    const contentType = stringField(body, "content_type") ?? ZIP_CONTENT_TYPE;
    const contentLength = numberField(body, "content_length") ?? 0;
    if (contentType !== ZIP_CONTENT_TYPE)
      throw new HttpError(400, "content_type must be application/zip");
    if (contentLength > MAX_UPLOAD_BYTES)
      throw new HttpError(413, "publish archive exceeds 200 MB limit");
    const uploadKey = `pub_${randomUUID().replaceAll("-", "")}`;
    const file = storage.bucket(env.uploadBucket).file(publishedUploadKey(uploadKey));
    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + SIGNED_URL_TTL_MS,
      contentType,
    });
    return c.json(
      data({
        upload_url: uploadUrl,
        upload_key: uploadKey,
        content_type: contentType,
        upload_headers: { "content-type": contentType },
        expires_in_seconds: Math.floor(SIGNED_URL_TTL_MS / 1000),
        file_name: basename(fileName),
      }),
    );
  };

  const completePublishHandler = async (c: Context) => {
    const body = await readJsonBody(c);
    const uploadKey = stringField(body, "upload_key");
    if (!uploadKey) throw new HttpError(400, "upload_key is required");
    const file = storage.bucket(env.uploadBucket).file(publishedUploadKey(uploadKey));
    const [exists] = await file.exists();
    if (!exists) throw new HttpError(409, "published upload object not found yet");
    const projectId = `ken_${randomUUID().replaceAll("-", "")}`;
    const title = stringField(body, "title") ?? "Kenect AI project";
    const response = createPublishedResponse({ projectId, title, appBaseUrl: env.appBaseUrl });
    await store.write(`published-projects/${projectId}.json`, {
      ...response,
      upload_key: uploadKey,
      source_gcs_key: publishedUploadKey(uploadKey),
      is_public: body["is_public"] === true,
      created_at: Date.now(),
    });
    return c.json(data(response));
  };

  const directPublishHandler = (c: Context) =>
    c.json({ message: "Use the staged publish upload flow." }, 405);

  const feedbackHandler = async (c: Context) => {
    const body = await readJsonBody(c);
    const id = `fb_${randomUUID().replaceAll("-", "")}`;
    await store.write(`feedback/${id}.json`, { id, ...body, created_at: Date.now() });
    return c.json({ ok: true });
  };

  app.post("/v1/kenectai/projects/publish/upload", preparePublishUploadHandler);
  app.post("/v1/kenectai/projects/publish/complete", completePublishHandler);
  app.post("/v1/kenectai/projects/publish", directPublishHandler);
  app.post("/v1/kenectai/feedback", feedbackHandler);
  app.post("/v1/hyperframes/projects/publish/upload", preparePublishUploadHandler);
  app.post("/v1/hyperframes/projects/publish/complete", completePublishHandler);
  app.post("/v1/hyperframes/projects/publish", directPublishHandler);
  app.post("/v1/hyperframes/feedback", feedbackHandler);

  app.post("/v1/products/frame-pack", async (c) => {
    const body = await readJsonBody(c);
    const sourceText = stringField(body, "source_text");
    if (!sourceText || sourceText.trim().length < 20) {
      throw new HttpError(400, "source_text is required and must be at least 20 characters");
    }
    if (sourceText.length > 300_000) {
      throw new HttpError(413, "source_text must be 300,000 characters or fewer");
    }
    const gemini = requireGemini(env);
    const jobId = `fp_${randomUUID().replaceAll("-", "")}`;
    const startedAt = Math.floor(Date.now() / 1000);
    try {
      const result = await generateFramePack(gemini, sourceText);
      const zip = new AdmZip();
      zip.addFile("FRAME.md", Buffer.from(result.frameMd, "utf8"));
      zip.addFile("frame-showcase.html", Buffer.from(result.frameShowcaseHtml, "utf8"));
      zip.addFile("README.html", Buffer.from(result.readmeHtml, "utf8"));
      const zipKey = `products/frame-pack/${jobId}/frame-pack.zip`;
      await storage.bucket(env.uploadBucket).file(zipKey).save(zip.toBuffer(), {
        contentType: ZIP_CONTENT_TYPE,
        resumable: false,
      });
      const [downloadUrl] = await storage
        .bucket(env.uploadBucket)
        .file(zipKey)
        .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
      await store.write(productJobKey("frame-pack", jobId), {
        job_id: jobId,
        product: "frame-pack",
        status: "completed",
        product_name: result.tokens.productName,
        download_url: downloadUrl,
        created_at: startedAt,
        completed_at: Math.floor(Date.now() / 1000),
      });
      return c.json({
        job_id: jobId,
        status: "completed",
        product_name: result.tokens.productName,
        download_url: downloadUrl,
        files: ["FRAME.md", "frame-showcase.html", "README.html"],
      });
    } catch (err) {
      await store
        .write(productJobKey("frame-pack", jobId), {
          job_id: jobId,
          product: "frame-pack",
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          created_at: startedAt,
          completed_at: Math.floor(Date.now() / 1000),
        })
        .catch(() => {});
      if (err instanceof GeminiError) throw new HttpError(502, err.message);
      throw err;
    }
  });

  app.get("/v1/products/frame-pack/:jobId", async (c) => {
    const record = await store.read(productJobKey("frame-pack", requiredParam(c, "jobId")));
    if (!record) throw new HttpError(404, "job not found");
    return c.json(record);
  });

  app.post("/v1/products/website-video", async (c) => {
    const body = await readJsonBody(c);
    const url = stringField(body, "url");
    if (!url || !url.startsWith("https://")) {
      throw new HttpError(400, "url is required and must be an HTTPS URL");
    }
    const durationRaw = numberField(body, "duration_s");
    const durationS = durationRaw && durationRaw >= 8 && durationRaw <= 60 ? durationRaw : 20;
    const title = stringField(body, "title");
    const gemini = requireGemini(env);
    const jobId = `wv_${randomUUID().replaceAll("-", "")}`;
    const startedAt = Math.floor(Date.now() / 1000);
    try {
      const composition = await generateWebsiteComposition(gemini, url, durationS);
      const zip = new AdmZip();
      zip.addFile("index.html", Buffer.from(composition.html, "utf8"));
      const renderResult = await dispatchRender({
        project: {
          type: "base64",
          media_type: ZIP_CONTENT_TYPE,
          data: zip.toBuffer().toString("base64"),
        },
        format: "mp4",
        quality: "standard",
        resolution: "1080p",
        aspect_ratio: "16:9",
        composition: "index.html",
        variables: null,
        title: title ?? composition.brandHints.title,
        callback_id: null,
        callback_url: null,
      });
      await store.write(productJobKey("website-video", jobId), {
        job_id: jobId,
        product: "website-video",
        status: "rendering",
        source_url: url,
        render_id: renderResult.render_id,
        repaired: composition.repaired,
        brand_hints: composition.brandHints,
        created_at: startedAt,
      });
      return c.json({
        job_id: jobId,
        render_id: renderResult.render_id,
        status: "rendering",
        poll_url: `/v3/kenectai/renders/${renderResult.render_id}`,
        repaired: composition.repaired,
        brand_hints: composition.brandHints,
      });
    } catch (err) {
      await store
        .write(productJobKey("website-video", jobId), {
          job_id: jobId,
          product: "website-video",
          status: "failed",
          source_url: url,
          error: err instanceof Error ? err.message : String(err),
          created_at: startedAt,
          completed_at: Math.floor(Date.now() / 1000),
        })
        .catch(() => {});
      if (err instanceof CompositionLintError) {
        throw new HttpError(422, err.message);
      }
      if (err instanceof GeminiError) throw new HttpError(502, err.message);
      throw err;
    }
  });

  app.get("/v1/products/website-video/:jobId", async (c) => {
    const record = await store.read(productJobKey("website-video", requiredParam(c, "jobId")));
    if (!record) throw new HttpError(404, "job not found");
    return c.json(record);
  });

  async function renderDetail(
    storageClient: Storage,
    record: RenderRecord,
  ): Promise<Record<string, unknown>> {
    const progress = await getRenderProgress({ executionName: record.execution_name });
    const status = mapProgressStatus(progress.status);
    const videoUrl =
      status === "completed" && progress.outputFile?.gcsUri
        ? await signedReadUrl(storageClient, progress.outputFile.gcsUri)
        : null;
    return {
      render_id: record.render_id,
      status,
      title: record.title,
      callback_id: record.callback_id,
      video_url: videoUrl,
      thumbnail_url: null,
      duration: null,
      fps: record.fps,
      quality: record.quality,
      format: record.format,
      resolution: record.resolution,
      aspect_ratio: record.aspect_ratio,
      composition: record.composition,
      created_at: record.created_at,
      completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
      failure_message: status === "failed" ? (progress.errors[0]?.cause ?? "render failed") : null,
    };
  }

  return app;
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  const port = Number(process.env["PORT"] ?? "8080");
  const app = createKenectApiApp();
  serve({ fetch: app.fetch, port });
  console.log(`Kenect API listening on :${port}`);
}
