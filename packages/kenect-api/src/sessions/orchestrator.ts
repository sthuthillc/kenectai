/**
 * KENECT Sessions orchestrator — a step machine that follows
 * skills/product-launch-video/SKILL.md's Steps 0→6 (and their gates)
 * verbatim, in autonomous mode:
 *
 *   - Judgment/authoring steps are Gemini Interactions API calls whose
 *     prompt context is the exact reference docs the skill's "Read" list
 *     names for that step (assembled by SkillLoader).
 *   - Mechanical steps spawn the skill's own deterministic scripts + the
 *     kenectai CLI (capture, build-frame, audio, stage-assets,
 *     sync-durations, fetch-sfx, captions, assemble-index, transitions,
 *     lint) with cwd = the session's project workspace.
 *   - Step 5 frame workers fan out as parallel Interactions calls, each
 *     given sub-agents/frame-worker.md + the kenectai-core composition
 *     contract + its own `## Frame N` storyboard block + its blueprint +
 *     the rule recipes its scene lines cite.
 *   - The final render reuses the existing dispatchRender → Cloud
 *     Workflows distributed pipeline (not `kenectai render` locally).
 *
 * Every step transition persists the session record so the MCP tools and
 * the web session page see live task/chat progress.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import AdmZip from "adm-zip";
import type { JsonStoreLike } from "../oauthServer.js";
import { InteractionsClient } from "./interactions.js";
import { SkillLoader } from "./skillLoader.js";
import {
  newSessionTasks,
  sessionKey,
  userSessionsKey,
  type SessionBrief,
  type SessionRecord,
  type SessionStepId,
  type UserSessionsIndex,
} from "./types.js";

const ZIP_CONTENT_TYPE = "application/zip";
/** Frame-worker fan-out width (Gemini calls in flight at once). */
const DEFAULT_WORKER_CONCURRENCY = 4;
/** Max re-dispatches of a failing frame with lint findings (skill Retry contract). */
const MAX_FRAME_RETRIES = 2;
/** How long Step 5 waits for the backgrounded Step 3.1 audio job. */
const AUDIO_WAIT_TIMEOUT_MS = 12 * 60_000;
/** Step 7 render polling. */
const RENDER_POLL_INTERVAL_MS = 15_000;
const RENDER_POLL_TIMEOUT_MS = 30 * 60_000;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
) => Promise<SpawnResult>;

export interface RenderStatus {
  status: string;
  video_url?: string | null;
  failure_message?: string | null;
}

export interface SessionDeps {
  store: JsonStoreLike;
  skills: SkillLoader;
  interactions: InteractionsClient;
  /** Reuses server.ts's dispatchRender closure (zip → Cloud Workflows). */
  dispatchRender: (body: {
    project: { type: "base64"; media_type: string; data: string };
    format: string;
    quality: string;
    resolution: string;
    aspect_ratio: string;
    composition: string;
    variables: null;
    title: string | null;
    callback_id: null;
    callback_url: null;
  }) => Promise<{ render_id: string }>;
  /** Reads a dispatched render's live status (server.ts render-status logic). */
  readRenderStatus: (renderId: string) => Promise<RenderStatus>;
  /** Absolute path to the built kenectai CLI entry (dist/cli.js). */
  cliPath: string;
  geminiApiKey: string;
  runShellCommand?: SpawnFn;
  workerConcurrency?: number;
  /** Test seam: shrink waits. */
  timing?: {
    audioWaitMs?: number;
    renderPollIntervalMs?: number;
    renderPollTimeoutMs?: number;
  };
  log?: (message: string) => void;
}

interface StoryboardFrame {
  index: number;
  number?: number;
  title?: string;
  status: string;
  src?: string;
  duration?: number;
  durationSeconds?: number;
  scene?: string;
  voiceover?: string;
  narrative: string;
  extra: Record<string, unknown>;
}

interface StoryboardManifest {
  globals: { format?: string; message?: string; extra: Record<string, unknown> };
  frames: StoryboardFrame[];
  warnings: Array<{ message: string; line?: number; frameIndex?: number }>;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "frame"
  );
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

class SessionFailure extends Error {}

// ── the session engine ───────────────────────────────────────────────────────

export class SessionEngine {
  private readonly deps: SessionDeps;
  private readonly spawnFn: SpawnFn;
  private record: SessionRecord;
  private projectDir = "";
  private audioJob: Promise<SpawnResult> | null = null;

  constructor(record: SessionRecord, deps: SessionDeps) {
    this.record = record;
    this.deps = deps;
    this.spawnFn = deps.runShellCommand ?? defaultSpawn;
  }

  private get skills(): SkillLoader {
    return this.deps.skills;
  }

  private log(message: string): void {
    this.deps.log?.(`[session ${this.record.id}] ${message}`);
  }

  private async persist(): Promise<void> {
    this.record.updated_at = nowSeconds();
    await this.deps.store.write(sessionKey(this.record.id), this.record);
  }

  private async chat(text: string): Promise<void> {
    this.record.chat.push({ role: "agent", text, ts: nowSeconds() });
    await this.persist();
  }

  private task(id: SessionStepId) {
    const task = this.record.tasks.find((t) => t.id === id);
    if (!task) throw new SessionFailure(`unknown task ${id}`);
    return task;
  }

  private async step<T>(id: SessionStepId, fn: () => Promise<T>): Promise<T> {
    const task = this.task(id);
    task.state = "running";
    task.started_at = nowSeconds();
    await this.persist();
    this.log(`▶ ${id}`);
    try {
      const result = await fn();
      task.state = "done";
      task.finished_at = nowSeconds();
      await this.persist();
      this.log(`✓ ${id}`);
      return result;
    } catch (err) {
      task.state = "failed";
      task.finished_at = nowSeconds();
      task.note = (err as Error).message.slice(0, 500);
      this.record.status = "failed";
      this.record.error = `${id}: ${(err as Error).message}`.slice(0, 1000);
      await this.persist();
      this.log(`✗ ${id}: ${(err as Error).message}`);
      throw err;
    }
  }

  private async run(
    command: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<SpawnResult> {
    return this.spawnFn(command, args, {
      cwd: this.projectDir,
      env: { GEMINI_API_KEY: this.deps.geminiApiKey, ...opts.env },
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
    });
  }

  private async runOrThrow(
    label: string,
    command: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<SpawnResult> {
    const result = await this.run(command, args, opts);
    if (result.code !== 0) {
      throw new SessionFailure(
        `${label} exited ${result.code}: ${capped(result.stderr || result.stdout, 1200)}`,
      );
    }
    return result;
  }

  private skillScript(rel: string): string {
    return this.skills.path(`product-launch-video/scripts/${rel}`);
  }

  private projectFile(rel: string): string {
    return join(this.projectDir, rel);
  }

  private readProjectFile(rel: string, cap = 20_000): string {
    const path = this.projectFile(rel);
    if (!existsSync(path)) return "";
    return capped(readFileSync(path, "utf8"), cap);
  }

  private async parseStoryboard(): Promise<StoryboardManifest> {
    const libPath = this.skillScript("lib/storyboard.mjs");
    const mod = (await import(pathToFileURL(libPath).href)) as {
      parseStoryboard: (source: string) => StoryboardManifest;
    };
    return mod.parseStoryboard(readFileSync(this.projectFile("STORYBOARD.md"), "utf8"));
  }

  // ── Step 0: setup + autonomous brief ───────────────────────────────────────

  private async step0Setup(): Promise<void> {
    await this.step("step-0-setup", async () => {
      const ws = mkdtempSync(join(tmpdir(), "kenect-session-"));
      this.projectDir = join(ws, "project");
      mkdirSync(this.projectDir, { recursive: true });
      writeFileSync(
        this.projectFile("kenectai.json"),
        JSON.stringify(
          {
            registry: "https://raw.githubusercontent.com/sthuthillc/kenectai/main/registry",
            paths: {
              blocks: "compositions",
              components: "compositions/components",
              assets: "assets",
            },
          },
          null,
          2,
        ),
      );

      const briefContract = this.skills.docBundle(["kenectai-core/references/brief-contract.md"]);
      const { value: brief } = await this.deps.interactions.interactJson<SessionBrief>({
        systemInstruction: `You are the orchestrator of the product-launch-video workflow running in AUTONOMOUS mode: every brief decision is made for the user, each with a stated reason. The brief contract:\n${briefContract}`,
        input:
          `Lock the video brief for a product launch promo of this website: ${this.record.url}\n\n` +
          `Reply with ONLY a JSON object: {"angle": string (story shape, e.g. "capability montage"), ` +
          `"length_s": number (30-45 preferred; never outside 20-90), ` +
          `"destination": string, "aspect": "16:9"|"1:1"|"9:16", ` +
          `"message": string (the ONE thing the promo must communicate, one sentence — provisional is fine, Step 3 may refine it), ` +
          `"language": string (BCP-47, default "en")}. ` +
          `Default destination is YouTube/embed → 16:9 unless the URL implies otherwise.`,
        temperature: 0.4,
        maxOutputTokens: 8000,
        thinkingLevel: "low",
      });
      brief.length_s = Math.min(90, Math.max(20, Math.round(brief.length_s || 30)));
      if (!["16:9", "1:1", "9:16"].includes(brief.aspect)) brief.aspect = "16:9";
      this.record.brief = brief;
      await this.chat(
        `Brief locked (autonomous): ${brief.length_s}s ${brief.aspect} for ${brief.destination}; angle "${brief.angle}"; message: "${brief.message}".`,
      );
    });
  }

  // ── Step 1: capture ────────────────────────────────────────────────────────

  private async step1Capture(): Promise<void> {
    await this.step("step-1-capture", async () => {
      const result = await this.run(
        process.execPath,
        [this.deps.cliPath, "capture", this.record.url, "-o", "./capture", "--json"],
        { timeoutMs: 6 * 60_000 },
      );
      const required = [
        "capture/extracted/tokens.json",
        "capture/extracted/visible-text.txt",
        "capture/extracted/asset-descriptions.md",
      ];
      const missing = required.filter((rel) => !existsSync(this.projectFile(rel)));
      if (result.code !== 0 || missing.length > 0) {
        // The skill's no-capture fallback path: hand-write the gate files so
        // the run degrades to brief-only material instead of dying here.
        this.log(
          `capture degraded (exit ${result.code}, missing ${missing.join(",") || "none"}) — using no-capture fallback`,
        );
        mkdirSync(this.projectFile("capture/extracted"), { recursive: true });
        mkdirSync(this.projectFile("capture/assets"), { recursive: true });
        const fallbackText = await this.fetchPageText();
        if (!existsSync(this.projectFile("capture/extracted/tokens.json"))) {
          writeFileSync(
            this.projectFile("capture/extracted/tokens.json"),
            JSON.stringify({ title: this.record.url, description: "", colors: [], fonts: [] }),
          );
        }
        if (!existsSync(this.projectFile("capture/extracted/visible-text.txt"))) {
          writeFileSync(this.projectFile("capture/extracted/visible-text.txt"), fallbackText);
        }
        if (!existsSync(this.projectFile("capture/extracted/asset-descriptions.md"))) {
          writeFileSync(
            this.projectFile("capture/extracted/asset-descriptions.md"),
            "# Assets\n\nNo assets were captured for this project.\n",
          );
        }
        await this.chat("Website capture was limited — continuing with page text only.");
      } else {
        await this.chat("Captured the website: brand tokens, visible text, and assets extracted.");
      }
    });
  }

  private async fetchPageText(): Promise<string> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(this.record.url, { signal: controller.signal });
      clearTimeout(timer);
      const html = await res.text();
      return capped(
        html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        20_000,
      );
    } catch {
      return "";
    }
  }

  // ── Step 2: design system (preset pick + deterministic remix) ─────────────

  private async step2Frame(): Promise<void> {
    await this.step("step-2-frame", async () => {
      const presets = this.skills.listFramePresets();
      if (presets.length === 0) throw new SessionFailure("no frame presets found in skills dir");
      const tokens = this.readProjectFile("capture/extracted/tokens.json", 4000);
      const { value } = await this.deps.interactions.interactJson<{
        preset: string;
        reason: string;
      }>({
        systemInstruction: `You are the orchestrator at Step 2 of product-launch-video: choose ONE shipped frame preset whose look best fits the brand and brief. Design-spec context:\n${this.skills.designSpecContext()}`,
        input:
          `Brief: ${JSON.stringify(this.record.brief)}\n\nBrand tokens (captured): ${tokens}\n\n` +
          `Presets:\n${presets.map((p) => `- ${p.name}: ${p.description}`).join("\n")}\n\n` +
          `Reply with ONLY JSON {"preset": "<name>", "reason": "<one line>"}.`,
        temperature: 0.4,
        maxOutputTokens: 8000,
        thinkingLevel: "low",
      });
      const preset = presets.some((p) => p.name === value.preset)
        ? value.preset
        : (presets[0]?.name as string);
      await this.runOrThrow("build-frame.mjs", process.execPath, [
        this.skillScript("build-frame.mjs"),
        "--preset",
        preset,
        "--kenectai",
        ".",
      ]);
      if (!existsSync(this.projectFile("frame.md"))) {
        throw new SessionFailure("build-frame.mjs exited 0 but frame.md is missing");
      }
      await this.chat(
        `Design system ready: preset "${preset}" remixed onto the brand — ${value.reason}`,
      );
    });
  }

  // ── Step 3: storyboard + script ────────────────────────────────────────────

  private async step3Storyboard(): Promise<void> {
    await this.step("step-3-storyboard", async () => {
      const context = this.skills.storyboardContext();
      const brief = this.record.brief as SessionBrief;
      const canvas =
        brief.aspect === "9:16" ? "1080x1920" : brief.aspect === "1:1" ? "1080x1080" : "1920x1080";
      const input =
        `Write STORYBOARD.md and SCRIPT.md for this product launch promo.\n\n` +
        `Brief: ${JSON.stringify(brief)}\nCanvas format: ${canvas}\n\n` +
        `Brand tokens: ${this.readProjectFile("capture/extracted/tokens.json", 4000)}\n\n` +
        `Website visible text:\n${this.readProjectFile("capture/extracted/visible-text.txt", 14_000)}\n\n` +
        `Asset inventory (the canonical source for asset_candidates):\n${this.readProjectFile("capture/extracted/asset-descriptions.md", 8000)}\n\n` +
        `Requirements:\n` +
        `- Follow storyboard-format.md exactly: YAML frontmatter (format: ${canvas}, message, arc, audience, mode: autonomous, and music: <a BGM mood/genre line, e.g. "confident minimal tech pulse, 100 BPM" — the audio engine generates the track from this>), then one "## Frame N — Title" per frame.\n` +
        `- 4 to 7 frames; per-frame metadata bullets MUST include: status: outline, src: compositions/frames/NN-<slug>.html, duration: <N>s, transition_in, scene, voiceover, blueprint (an id from blueprints-index.md or "compose"), asset_candidates.\n` +
        `- Frame durations sum to ~${brief.length_s}s.\n` +
        `- SCRIPT.md follows script-format.md: header (Voice/Voice direction), then "## Line N — <label> (Frame N)" sections; the indented block is the spoken text; one line per frame with a voiceover.\n\n` +
        `Output BOTH files, delimited EXACTLY like this (no other prose):\n` +
        `===== STORYBOARD.md =====\n<file content>\n===== SCRIPT.md =====\n<file content>`;

      const author = async (repairNote?: string) => {
        const { text } = await this.deps.interactions.interact({
          systemInstruction: `You are the orchestrator at Step 3 of product-launch-video (autonomous mode), turning the brief and captured material into a frame-by-frame story plan. Reference docs:\n${context}`,
          input: repairNote
            ? `${input}\n\nYour previous attempt failed validation: ${repairNote}\nFix those problems and output both files again.`
            : input,
          temperature: 0.6,
          maxOutputTokens: 65_536,
          thinkingLevel: "high",
        });
        const parts = text.split(/=====\s*SCRIPT\.md\s*=====/);
        const storyboard = (parts[0] ?? "")
          .replace(/^[\s\S]*?=====\s*STORYBOARD\.md\s*=====/, "")
          .trim();
        const script = (parts[1] ?? "").trim();
        if (!storyboard) throw new SessionFailure("Step 3 output missing STORYBOARD.md section");
        writeFileSync(this.projectFile("STORYBOARD.md"), `${storyboard}\n`);
        if (script) writeFileSync(this.projectFile("SCRIPT.md"), `${script}\n`);
      };

      await author();
      let manifest = await this.parseStoryboard();
      let problems = validateStoryboard(manifest);
      if (problems.length > 0) {
        await author(problems.join("; "));
        manifest = await this.parseStoryboard();
        problems = validateStoryboard(manifest);
        if (problems.length > 0) {
          throw new SessionFailure(`storyboard failed validation twice: ${problems.join("; ")}`);
        }
      }
      const summary = manifest.frames
        .map(
          (f) =>
            `${f.number ?? f.index + 1}. ${f.title ?? f.scene ?? "frame"} (${f.duration ?? "?"}s)`,
        )
        .join(" · ");
      await this.chat(
        `Storyboard drafted — this video tells the audience that "${this.record.brief?.message}". Frames: ${summary}`,
      );
    });
  }

  // ── Step 3.1: audio (backgrounded) ─────────────────────────────────────────

  private step31AudioStart(): void {
    const task = this.task("step-3.1-audio");
    if (!existsSync(this.projectFile("SCRIPT.md"))) {
      task.state = "skipped";
      task.note = "silent project (no SCRIPT.md)";
      return;
    }
    task.state = "running";
    task.started_at = nowSeconds();
    this.audioJob = this.run(
      process.execPath,
      [
        this.skillScript("audio.mjs"),
        "--script",
        "./SCRIPT.md",
        "--storyboard",
        "./STORYBOARD.md",
        "--kenectai",
        ".",
        "--out",
        "./audio_meta.json",
      ],
      { timeoutMs: this.deps.timing?.audioWaitMs ?? AUDIO_WAIT_TIMEOUT_MS },
    );
    this.log("step-3.1-audio started in background");
  }

  private async step31AudioAwait(): Promise<void> {
    const task = this.task("step-3.1-audio");
    if (task.state === "skipped" || !this.audioJob) return;
    const result = await this.audioJob;
    if (result.code !== 0 || !existsSync(this.projectFile("audio_meta.json"))) {
      // Per the skill: missing/failed audio degrades to a silent video, it
      // never blocks the render.
      task.state = "failed";
      task.note = capped(result.stderr || result.stdout, 300);
      await this.chat("Audio generation failed — continuing with a silent video.");
    } else {
      task.state = "done";
      task.finished_at = nowSeconds();
      await this.chat("Narration, music, and timings are ready.");
    }
    await this.persist();
  }

  // ── Step 4: frame visual design ────────────────────────────────────────────

  private async step4Visual(): Promise<void> {
    await this.step("step-4-visual", async () => {
      const storyboard = this.readProjectFile("STORYBOARD.md", 24_000);
      const { text } = await this.deps.interactions.interact({
        systemInstruction: `You are the orchestrator at Step 4 of product-launch-video: enrich STORYBOARD.md IN PLACE with each visual frame's time-coded shot sequence and one video-wide "## Video direction" block. Do not change story, script, asset choices, asset_candidates, transition_in, durations, or src paths. Do not write HTML. Reference docs:\n${this.skills.visualDesignContext()}`,
        input:
          `frame.md (design truth):\n${this.readProjectFile("frame.md", 10_000)}\n\n` +
          `Current STORYBOARD.md:\n${storyboard}\n\n` +
          `Rewrite the COMPLETE STORYBOARD.md with, for every visual frame: a time-coded shot sequence ` +
          `("Scene 1 (0.0–Xs): … → Scene 2 …") whose reveals are paced to the voiceover (never front-loaded), ` +
          `layout and named motions inline (motion names must come from rules-index.md; blueprint ids from blueprints-index.md), ` +
          `plus one "## Video direction" block at the end. Output ONLY the full markdown file.`,
        temperature: 0.5,
        maxOutputTokens: 65_536,
        thinkingLevel: "high",
      });
      if (!/##\s*Video direction/i.test(text)) {
        throw new SessionFailure("Step 4 output missing the '## Video direction' block");
      }
      writeFileSync(this.projectFile("STORYBOARD.md"), `${text.trim()}\n`);
      const staged = await this.run(process.execPath, [
        this.skillScript("stage-assets.mjs"),
        "--storyboard",
        "./STORYBOARD.md",
        "--kenectai",
        ".",
      ]);
      if (staged.code !== 0) this.log(`stage-assets degraded: ${capped(staged.stderr, 300)}`);
      await this.chat("Every frame now has a time-coded shot sequence and motion plan.");
    });
  }

  // ── Step 5: build frames + assemble ────────────────────────────────────────

  private async step5Build(): Promise<void> {
    await this.step("step-5-build", async () => {
      await this.step31AudioAwait();

      if (existsSync(this.projectFile("audio_meta.json"))) {
        await this.run(process.execPath, [
          this.skillScript("audio.mjs"),
          "sync-durations",
          "--audio-meta",
          "./audio_meta.json",
          "--storyboard",
          "./STORYBOARD.md",
        ]);
        await this.run(process.execPath, [
          this.skillScript("audio.mjs"),
          "fetch-sfx",
          "--storyboard",
          "./STORYBOARD.md",
          "--kenectai",
          ".",
        ]);
        const waitBgm = this.skills.path("media-use/audio/scripts/wait-bgm.mjs");
        if (existsSync(waitBgm)) {
          await this.run(process.execPath, [
            waitBgm,
            "--audio-meta",
            "./audio_meta.json",
            "--kenectai",
            ".",
          ]);
        }
      }

      const manifest = await this.parseStoryboard();
      mkdirSync(this.projectFile("compositions/frames"), { recursive: true });
      const concurrency = this.deps.workerConcurrency ?? DEFAULT_WORKER_CONCURRENCY;
      const queue = [...manifest.frames.entries()];
      const failures: string[] = [];
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          const [i, frame] = next;
          try {
            await this.buildFrame(frame, i, manifest.frames.length);
          } catch (err) {
            failures.push(`${frameId(frame, i)}: ${(err as Error).message}`);
          }
        }
      });
      await Promise.all(workers);
      if (failures.length > 0) {
        throw new SessionFailure(`frame workers failed: ${failures.join(" | ")}`);
      }

      if (existsSync(this.projectFile("audio_meta.json"))) {
        await this.run(process.execPath, [
          this.skillScript("captions.mjs"),
          "build",
          "--storyboard",
          "./STORYBOARD.md",
          "--audio-meta",
          "./audio_meta.json",
          "--kenectai",
          ".",
          "--out",
          "./caption_groups.json",
        ]);
      }
      await this.runOrThrow("assemble-index.mjs", process.execPath, [
        this.skillScript("assemble-index.mjs"),
        "--storyboard",
        "./STORYBOARD.md",
        "--kenectai",
        ".",
      ]);
      if (!existsSync(this.projectFile("index.html"))) {
        throw new SessionFailure("assemble-index exited 0 but index.html is missing");
      }
      await this.chat(`Built ${manifest.frames.length} frames and assembled the composition.`);
    });
  }

  private async buildFrame(
    frame: StoryboardFrame,
    index: number,
    total: number,
    retryFindings?: string,
  ): Promise<void> {
    const id = frameId(frame, index);
    const blueprintId = String(frame.extra["blueprint"] ?? "compose");
    const blueprint = this.skills.blueprint(blueprintId);
    const frameBlock = extractFrameBlock(
      readFileSync(this.projectFile("STORYBOARD.md"), "utf8"),
      frame,
      index,
    );
    const rules = this.skills.rulesCitedIn(frameBlock);
    const brief = this.record.brief as SessionBrief;
    const canvas =
      brief.aspect === "9:16" ? "1080×1920" : brief.aspect === "1:1" ? "1080×1080" : "1920×1080";
    const captionsEnabled = existsSync(this.projectFile("SCRIPT.md"));

    const systemInstruction =
      `${this.skills.frameWorkerPrompt()}\n\n` +
      `===== kenectai-core composition contract =====\n${this.skills.coreCompositionContract()}\n\n` +
      `===== cut catalog =====\n${this.skills.cutCatalog()}`;
    const input =
      `PROJECT context — frame_id: ${id} (frame ${index + 1} of ${total}); canvas ${canvas}; ` +
      `Captions: ${captionsEnabled ? "enabled (keep-out: bottom 17%)" : "disabled (keep-out still applies)"}.\n\n` +
      `frame.md (design truth):\n${this.readProjectFile("frame.md", 10_000)}\n\n` +
      `Your "## Frame" block from STORYBOARD.md:\n${frameBlock}\n\n` +
      (blueprint ? `Blueprint template (${blueprintId}):\n${capped(blueprint, 8000)}\n\n` : "") +
      (rules.length > 0
        ? `Rule recipes for the named motions:\n${rules.map((r) => `--- ${r.id} ---\n${capped(r.body, 4000)}`).join("\n")}\n\n`
        : "") +
      currentHtmlSection(retryFindings, this.tryReadFrameFile(frame, id)) +
      `Available asset files (project-root-relative). You may reference ONLY these exact paths in <img>/src/url() — never a path with "../", never an invented filename, and never prefix a listed path with "../" (sub-compositions resolve media against the PROJECT ROOT). If a visual you need is not in this list, draw it with inline SVG or pure CSS instead:\n${this.listProjectAssets() || "(none — build every visual with inline SVG / CSS)"}\n\n` +
      `Hard output constraints:\n` +
      `- The composition root inside <template> carries data-composition-id="${id}" and the paused timeline is registered at window.__timelines["${id}"].\n` +
      `- Clips on the SAME data-track-index must never overlap in time — concurrent elements each get their own track index; a full-duration background clip sits alone on its track.\n` +
      `- The renderer is a clean OFFLINE headless Chrome: never @import or <link> fonts from the network (fonts.googleapis.com etc.) — use an @font-face pointing at a font file that ships with the project, or a system-safe stack (system-ui / Helvetica / Arial). The pinned GSAP <script src> from the core contract is the ONLY allowed external URL.\n` +
      `- Output ONLY the raw HTML document — no prose, no markdown fences.\n\n` +
      (retryFindings
        ? `Apply the minimal edits that clear every finding and output the FULL corrected file.`
        : `Write the complete sub-composition HTML file now.`);

    // Three authoring attempts: replies can be truncated (thought tokens
    // share the max_output_tokens budget — the client throws on
    // status:"incomplete") or wrapped in prose. Salvage the
    // <template>…</template> slice first; re-ask with the rejection reason
    // only when there is nothing salvageable.
    let html: string | null = null;
    let lastProblem = "";
    for (let attempt = 0; attempt < 3 && html === null; attempt++) {
      // Fresh authoring gets full reasoning; fix-up passes (lint findings or
      // a rejected reply) run at medium — observed live, "high" on the more
      // constrained retry prompts triggers runaway thinking that exhausts
      // even a 64k output budget (thought tokens share it) and takes 3-4
      // minutes per attempt.
      const thinkingLevel = retryFindings || attempt > 0 ? "medium" : "high";
      let text: string;
      try {
        ({ text } = await this.deps.interactions.interact({
          systemInstruction,
          input:
            attempt === 0
              ? input
              : `${input}\n\nYour previous reply was rejected: ${lastProblem}. Reply with the raw HTML file ONLY — it must contain a <template> wrapping the composition root and register window.__timelines["${id}"].`,
          temperature: 0.55,
          maxOutputTokens: 65_536,
          thinkingLevel,
        }));
      } catch (err) {
        lastProblem = (err as Error).message.slice(0, 200);
        this.log(`frame ${id} attempt ${attempt + 1} failed: ${lastProblem}`);
        continue;
      }
      html = salvageCompositionHtml(text);
      if (html === null) {
        lastProblem = "no <template>…</template> composition found in the reply";
      } else if (!html.includes("__timelines")) {
        lastProblem = "the composition never registers window.__timelines";
        html = null;
      }
    }
    if (html === null) {
      throw new SessionFailure(`frame ${id}: ${lastProblem} (after 3 attempts)`);
    }
    const rel =
      frame.src && frame.src.startsWith("compositions/")
        ? frame.src
        : `compositions/frames/${id}.html`;
    mkdirSync(dirname(this.projectFile(rel)), { recursive: true });
    writeFileSync(this.projectFile(rel), `${html.trim()}\n`);
    this.markFrameStatus(frame, index, "animated");
  }

  /** The frame's currently-written HTML, if a prior worker pass produced one. */
  private tryReadFrameFile(frame: StoryboardFrame, id: string): string | null {
    const rel =
      frame.src && frame.src.startsWith("compositions/")
        ? frame.src
        : `compositions/frames/${id}.html`;
    const abs = this.projectFile(rel);
    return existsSync(abs) ? capped(readFileSync(abs, "utf8"), 14_000) : null;
  }

  /**
   * Project-root-relative paths of every referenceable media asset on disk
   * (staged `assets/` plus raw `capture/assets/`), newline-joined and
   * capped — the worker's whitelist against invented asset paths.
   */
  private listProjectAssets(): string {
    const exts = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff2", ".woff"]);
    const out: string[] = [];
    const walk = (rel: string): void => {
      const abs = this.projectFile(rel);
      if (!existsSync(abs)) return;
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (out.length >= 80) return;
        if (entry.isDirectory()) walk(childRel);
        else if (exts.has(extname(entry.name).toLowerCase())) out.push(childRel);
      }
    };
    walk("assets");
    walk("capture/assets");
    return out.join("\n");
  }

  /** Orchestrator-owned storyboard state: flip one frame's `- status:` bullet. */
  private markFrameStatus(frame: StoryboardFrame, index: number, status: string): void {
    const path = this.projectFile("STORYBOARD.md");
    const source = readFileSync(path, "utf8");
    const block = extractFrameBlock(source, frame, index);
    const updated = block.replace(/(-\s*status:\s*)\S+/, `$1${status}`);
    if (updated !== block) writeFileSync(path, source.replace(block, updated));
  }

  // ── Step 6: finalize (transitions, lint, retry loop, render dispatch) ──────

  private async step6Finalize(): Promise<void> {
    await this.step("step-6-finalize", async () => {
      await this.run(process.execPath, [
        this.skillScript("transitions.mjs"),
        "inject",
        "--storyboard",
        "./STORYBOARD.md",
        "--kenectai",
        ".",
      ]);
      await this.run(process.execPath, [
        this.skillScript("transitions.mjs"),
        "verify",
        "--storyboard",
        "./STORYBOARD.md",
        "--index",
        "./index.html",
      ]);

      // Lint the assembled project with the CLI; retry failing frames with
      // the findings (the frame-worker Retry contract), then re-lint.
      for (let attempt = 0; attempt <= MAX_FRAME_RETRIES; attempt++) {
        const lint = await this.run(process.execPath, [this.deps.cliPath, "lint", ".", "--json"]);
        const findings = parseLintFindings(lint.stdout);
        const errors = findings.filter((f) => f.severity === "error");
        if (lint.code === 0 || errors.length === 0) break;
        if (attempt === MAX_FRAME_RETRIES) {
          throw new SessionFailure(
            `lint still failing after ${MAX_FRAME_RETRIES} frame retries: ${errors
              .slice(0, 6)
              .map((f) => `${f.file ?? "?"}: ${f.message}`)
              .join(" | ")}`,
          );
        }
        const manifest = await this.parseStoryboard();
        const byFrame = new Map<number, string[]>();
        for (const finding of errors) {
          const idx = manifest.frames.findIndex(
            (f, i) =>
              finding.file?.includes(frameId(f, i)) || (f.src && finding.file?.includes(f.src)),
          );
          if (idx >= 0) {
            const list = byFrame.get(idx) ?? [];
            list.push(`${finding.code ?? "error"}: ${finding.message}`);
            byFrame.set(idx, list);
          }
        }
        if (byFrame.size === 0) break; // findings we can't attribute — surface via next lint
        for (const [idx, notes] of byFrame) {
          const frame = manifest.frames[idx] as StoryboardFrame;
          this.log(`re-dispatching frame ${frameId(frame, idx)} with ${notes.length} finding(s)`);
          await this.buildFrame(frame, idx, manifest.frames.length, notes.join("\n"));
        }
        await this.run(process.execPath, [
          this.skillScript("transitions.mjs"),
          "inject",
          "--storyboard",
          "./STORYBOARD.md",
          "--kenectai",
          ".",
        ]);
      }

      const zip = new AdmZip();
      zip.addLocalFolder(this.projectDir, "", (path) => !path.startsWith("capture/screenshots"));
      const brief = this.record.brief as SessionBrief;
      const { render_id } = await this.deps.dispatchRender({
        project: {
          type: "base64",
          media_type: ZIP_CONTENT_TYPE,
          data: zip.toBuffer().toString("base64"),
        },
        format: "mp4",
        quality: "high",
        resolution: "1080p",
        aspect_ratio: brief.aspect,
        composition: "index.html",
        variables: null,
        title: brief.message,
        callback_id: null,
        callback_url: null,
      });
      this.record.render_id = render_id;
      await this.chat(`Checks passed — rendering the final MP4 (render ${render_id}).`);
    });
  }

  // ── Step 7: deliver ────────────────────────────────────────────────────────

  private async step7Deliver(): Promise<void> {
    await this.step("step-7-deliver", async () => {
      const renderId = this.record.render_id;
      if (!renderId) throw new SessionFailure("no render_id from step 6");
      const interval = this.deps.timing?.renderPollIntervalMs ?? RENDER_POLL_INTERVAL_MS;
      const deadline =
        Date.now() + (this.deps.timing?.renderPollTimeoutMs ?? RENDER_POLL_TIMEOUT_MS);
      for (;;) {
        const status = await this.deps.readRenderStatus(renderId);
        if (status.status === "completed" && status.video_url) {
          this.record.video_url = status.video_url;
          await this.chat(
            `Your video is ready: ${this.record.brief?.length_s}s, ${this.record.brief?.aspect}.`,
          );
          return;
        }
        if (status.status === "failed") {
          throw new SessionFailure(
            `render failed: ${capped(status.failure_message ?? "unknown", 600)}`,
          );
        }
        if (Date.now() > deadline) throw new SessionFailure("render timed out");
        await new Promise((r) => setTimeout(r, interval));
      }
    });
  }

  // ── entry ──────────────────────────────────────────────────────────────────

  async runAll(): Promise<SessionRecord> {
    this.record.status = "running";
    await this.persist();
    try {
      await this.step0Setup();
      await this.step1Capture();
      await this.step2Frame();
      await this.step3Storyboard();
      this.step31AudioStart();
      await this.persist();
      await this.step4Visual();
      await this.step5Build();
      await this.step6Finalize();
      await this.step7Deliver();
      this.record.status = "completed";
      await this.persist();
    } catch {
      // step() already recorded the failure state + error on the record.
    }
    return this.record;
  }
}

// ── helpers (exported for tests) ─────────────────────────────────────────────

/**
 * The retry prompt's fix-in-place section: the lint findings plus the
 * frame's current file, so the worker EDITS its previous output instead of
 * re-authoring from scratch (observed live: from-scratch retries fix the
 * named findings but introduce brand-new ones, and the loop never
 * converges).
 */
function currentHtmlSection(retryFindings: string | undefined, currentHtml: string | null): string {
  if (!retryFindings) return "";
  const findings = `RETRY — the assembled project failed lint/validate on YOUR frame with these findings; treat each as a hard constraint:\n${retryFindings}\n\n`;
  if (!currentHtml) return findings;
  return (
    findings +
    `Your frame's CURRENT file is below. Fix ONLY what the findings name and keep everything else byte-identical — do not redesign, rename ids, or restructure the timeline:\n${currentHtml}\n\n`
  );
}

/**
 * Pull the composition file out of a model reply that may carry prose or
 * fences around it. Preference: a full HTML document when present,
 * otherwise the first-<template>…last-</template> slice wrapped in a
 * minimal document. Null when there's no template at all.
 */
export function salvageCompositionHtml(text: string): string | null {
  const start = text.indexOf("<template");
  const end = text.lastIndexOf("</template>");
  if (start === -1 || end === -1 || end < start) return null;
  const docStart = text.indexOf("<!DOCTYPE");
  const docStartLower = text.indexOf("<!doctype");
  const htmlStart = docStart !== -1 ? docStart : docStartLower;
  const htmlEnd = text.lastIndexOf("</html>");
  if (htmlStart !== -1 && htmlEnd > htmlStart && htmlStart < start) {
    return text.slice(htmlStart, htmlEnd + "</html>".length);
  }
  const template = text.slice(start, end + "</template>".length);
  return `<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"></head>\n<body>\n${template}\n</body>\n</html>`;
}

export function frameId(frame: StoryboardFrame, index: number): string {
  const fromSrc = frame.src ? /frames\/([^/]+)\.html$/.exec(frame.src)?.[1] : undefined;
  if (fromSrc) return fromSrc;
  const n = String(frame.number ?? index + 1).padStart(2, "0");
  return `${n}-${slugify(frame.title ?? frame.scene ?? "frame")}`;
}

/** The frame's own `## Frame N …` block (heading through the next H2). */
export function extractFrameBlock(
  storyboard: string,
  frame: StoryboardFrame,
  index: number,
): string {
  const headings = [...storyboard.matchAll(/^##\s+(?:Frame|Beat|Scene)\b.*$/gim)];
  const heading = headings[index];
  if (!heading || heading.index === undefined) return storyboard;
  const start = heading.index;
  const next = headings[index + 1];
  const end = next?.index ?? storyboard.length;
  return storyboard.slice(start, end).trim();
}

export function validateStoryboard(manifest: StoryboardManifest): string[] {
  const problems: string[] = [];
  if (manifest.frames.length < 3) {
    problems.push(`only ${manifest.frames.length} frames (need at least 3)`);
  }
  manifest.frames.forEach((frame, i) => {
    const label = `frame ${frame.number ?? i + 1}`;
    const duration = frame.durationSeconds ?? frame.duration;
    if (!duration || Number(duration) <= 0) problems.push(`${label}: missing duration`);
    if (!frame.scene && !frame.title) problems.push(`${label}: missing scene caption`);
    if (!frame.src) problems.push(`${label}: missing src (compositions/frames/NN-*.html)`);
  });
  return problems;
}

interface LintFinding {
  severity?: string;
  code?: string;
  message: string;
  file?: string;
}

export function parseLintFindings(stdout: string): LintFinding[] {
  // `kenectai lint --json` prints a JSON document; tolerate leading noise.
  const start = stdout.indexOf("{");
  const startArr = stdout.indexOf("[");
  const idx = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (idx === -1) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(idx));
    const list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { findings?: unknown[] }).findings ?? []);
    return (list as Array<Record<string, unknown>>).map((f) => ({
      severity: typeof f["severity"] === "string" ? (f["severity"] as string) : undefined,
      code: typeof f["code"] === "string" ? (f["code"] as string) : undefined,
      message: String(f["message"] ?? ""),
      file: typeof f["file"] === "string" ? (f["file"] as string) : undefined,
    }));
  } catch {
    return [];
  }
}

// ── session creation + background launch ─────────────────────────────────────

export async function createSessionRecord(
  store: JsonStoreLike,
  input: { id: string; userId: string; url: string },
): Promise<SessionRecord> {
  const record: SessionRecord = {
    id: input.id,
    user_id: input.userId,
    url: input.url,
    status: "queued",
    tasks: newSessionTasks(),
    chat: [
      {
        role: "agent",
        text: `Starting a launch video for ${input.url} — following the product-launch-video workflow.`,
        ts: nowSeconds(),
      },
    ],
    usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
    created_at: nowSeconds(),
    updated_at: nowSeconds(),
  };
  await store.write(sessionKey(record.id), record);
  const index = (await store.read<UserSessionsIndex>(userSessionsKey(input.userId))) ?? {
    sessions: [],
  };
  index.sessions.unshift({
    id: record.id,
    url: record.url,
    status: record.status,
    created_at: record.created_at,
  });
  index.sessions = index.sessions.slice(0, 100);
  await store.write(userSessionsKey(input.userId), index);
  return record;
}

/** Resolve the built kenectai CLI entry, preferring the env override. */
export function resolveCliPath(): string {
  const fromEnv = process.env["KENECT_CLI_PATH"]?.trim();
  if (fromEnv) return fromEnv;
  // repo/container layout: <root>/packages/cli/dist/cli.js — walk up from
  // the skills root's parent, which is the monorepo root in both layouts.
  const root = dirname(new SkillLoader().root);
  const candidate = join(root, "packages/cli/dist/cli.js");
  if (existsSync(candidate)) return candidate;
  return resolve("packages/cli/dist/cli.js");
}
