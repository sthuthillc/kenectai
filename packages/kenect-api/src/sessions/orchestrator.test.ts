/**
 * Sessions orchestrator tests — the full step machine driven with a mocked
 * Interactions client and a mocked spawn that fabricates each skill
 * script's output files (the deterministic scripts have their own tests in
 * the skills tree; here we test the ORCHESTRATION: step order, gates,
 * storyboard state, worker fan-out, lint retry attribution, render
 * dispatch, and record/task persistence).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonStoreLike } from "../oauthServer.js";
import type { InteractionsClient, InteractResult } from "./interactions.js";
import {
  createSessionRecord,
  extractFrameBlock,
  frameId,
  parseLintFindings,
  SessionEngine,
  validateStoryboard,
  type SessionDeps,
  type SpawnFn,
} from "./orchestrator.js";
import { SkillLoader } from "./skillLoader.js";
import { sessionKey, type SessionRecord } from "./types.js";

// ── in-memory JsonStore ───────────────────────────────────────────────────────

class MemStore implements JsonStoreLike {
  readonly files = new Map<string, unknown>();
  async write<T>(key: string, value: T): Promise<void> {
    this.files.set(key, JSON.parse(JSON.stringify(value)));
  }
  async read<T>(key: string): Promise<T | null> {
    return (this.files.get(key) as T) ?? null;
  }
  async list<T>(prefix: string, limit: number): Promise<T[]> {
    return [...this.files.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .slice(0, limit)
      .map(([, v]) => v as T);
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}

// ── canned model outputs ──────────────────────────────────────────────────────

const STORYBOARD = `---
format: 1920x1080
message: Ship AI agents that close deals
arc: Hook -> Value -> Proof -> CTA
audience: agency owners
mode: autonomous
---

## Frame 1 — Hook

- status: outline
- src: compositions/frames/01-hook.html
- duration: 6s
- transition_in: cut
- scene: Brand wordmark slams in
- voiceover: Meet Amro Agents.
- blueprint: titlecard-reveal
- asset_candidates: none

Opening beat.

## Frame 2 — Value

- status: outline
- src: compositions/frames/02-value.html
- duration: 8s
- transition_in: crossfade
- scene: Three capability cards cascade
- voiceover: Automate follow-ups, scheduling, and client chat.
- blueprint: compose
- asset_candidates: none

Value beat with spring-pop-entrance reveals.

## Frame 3 — Proof

- status: outline
- src: compositions/frames/03-proof.html
- duration: 8s
- transition_in: wipe
- scene: Stat counters climb
- voiceover: Teams save twenty hours a week.
- blueprint: dataviz-countup
- asset_candidates: none

Proof beat.

## Frame 4 — CTA

- status: outline
- src: compositions/frames/04-cta.html
- duration: 8s
- transition_in: crossfade
- scene: Logo lockup with the site URL
- voiceover: Start at amroagents dot com.
- blueprint: logo-assemble-lockup
- asset_candidates: none

Closing beat.
`;

const SCRIPT = `# SCRIPT — amro-launch

**Voice:** Kore (Gemini)
**Voice direction:** Confident, warm.

## Line 1 — Hook (Frame 1)

    Meet Amro Agents.

## Line 2 — Value (Frame 2)

    Automate follow-ups, scheduling, and client chat.
`;

const FRAME_HTML = `<template data-composition-id="X">
<style>#root{background:#000}</style>
<div id="root"><div class="clip" data-start="0" data-duration="6" data-track-index="1">hi</div></div>
<script>window.__timelines = window.__timelines || {}; window.__timelines["X"] = gsap.timeline({paused:true});</script>
</template>`;

function mockInteractions(overrides?: { storyboardFirstBroken?: boolean }): {
  client: InteractionsClient;
  calls: string[];
} {
  const calls: string[] = [];
  let storyboardAttempts = 0;
  const interact = async (options: {
    input: string;
    systemInstruction?: string;
  }): Promise<InteractResult> => {
    const sys = options.systemInstruction ?? "";
    const usage = { input_tokens: 100, output_tokens: 100 };
    // Step 0 brief
    if (options.input.startsWith("Lock the video brief")) {
      calls.push("brief");
      return {
        text: JSON.stringify({
          angle: "capability montage",
          length_s: 30,
          destination: "YouTube",
          aspect: "16:9",
          message: "Ship AI agents that close deals",
          language: "en",
        }),
        interactionId: "i1",
        usage,
      };
    }
    // Step 2 preset
    if (sys.includes("Step 2")) {
      calls.push("preset");
      return {
        text: JSON.stringify({ preset: "capsule", reason: "clean SaaS look" }),
        interactionId: "i2",
        usage,
      };
    }
    // Step 3 storyboard + script
    if (sys.includes("Step 3")) {
      storyboardAttempts += 1;
      calls.push(`storyboard#${storyboardAttempts}`);
      const board =
        overrides?.storyboardFirstBroken && storyboardAttempts === 1
          ? STORYBOARD.replaceAll(/- src: [^\n]+\n/g, "") // drop src → validation failure
          : STORYBOARD;
      return {
        text: `===== STORYBOARD.md =====\n${board}\n===== SCRIPT.md =====\n${SCRIPT}`,
        interactionId: "i3",
        usage,
      };
    }
    // Step 4 visual enrichment
    if (sys.includes("Step 4")) {
      calls.push("visual");
      return {
        text: `${STORYBOARD}\n## Video direction\n\nMacro push-in throughout.\n`,
        interactionId: "i4",
        usage,
      };
    }
    // Step 5 frame workers (system prompt is frame-worker.md)
    if (sys.includes("Frame worker")) {
      calls.push("worker");
      return { text: FRAME_HTML, interactionId: "i5", usage };
    }
    throw new Error(`unmatched interaction: ${options.input.slice(0, 80)}`);
  };
  const client = {
    interact,
    interactJson: async (options: { input: string; systemInstruction?: string }) => {
      const result = await interact(options);
      return { ...result, value: JSON.parse(result.text) };
    },
  } as unknown as InteractionsClient;
  return { client, calls };
}

interface SpawnLogEntry {
  args: string[];
}

function mockSpawn(log: SpawnLogEntry[], opts?: { lintErrorOnce?: boolean }): SpawnFn {
  let lintCalls = 0;
  return async (_command, args, options) => {
    log.push({ args });
    const joined = args.join(" ");
    const at = (rel: string) => join(options.cwd, rel);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (joined.includes(" capture ") || args.includes("capture")) {
      mkdirSync(at("capture/extracted"), { recursive: true });
      mkdirSync(at("capture/assets"), { recursive: true });
      writeFileSync(
        at("capture/extracted/tokens.json"),
        JSON.stringify({ title: "Amro", colors: ["#123456"], fonts: ["Inter"] }),
      );
      writeFileSync(
        at("capture/extracted/visible-text.txt"),
        "Amro Agents automates real estate follow-ups.",
      );
      writeFileSync(
        at("capture/extracted/asset-descriptions.md"),
        "# Assets\n\n- logo.svg — the logo\n",
      );
      return ok;
    }
    if (joined.includes("build-frame.mjs")) {
      writeFileSync(at("frame.md"), "---\ncolors:\n  canvas: '#0b0f14'\n---\n# Frame spec\n");
      mkdirSync(at(".kenectai"), { recursive: true });
      writeFileSync(at(".kenectai/caption-skin.html"), "<div id='caption'></div>");
      return ok;
    }
    if (joined.includes("audio.mjs") && joined.includes("--out")) {
      writeFileSync(
        at("audio_meta.json"),
        JSON.stringify({
          voices: [{ id: "line-1", path: "assets/voice/1.wav", duration_s: 2 }],
          bgm: null,
          sfx: [],
          total_duration_s: 30,
        }),
      );
      return ok;
    }
    if (joined.includes("assemble-index.mjs")) {
      writeFileSync(
        at("index.html"),
        "<html><div id='root' data-composition-id='main'></div></html>",
      );
      return ok;
    }
    if (args.some((a) => a.endsWith("cli.js")) && args.includes("lint")) {
      lintCalls += 1;
      if (opts?.lintErrorOnce && lintCalls === 1) {
        return {
          code: 1,
          stdout: JSON.stringify({
            findings: [
              {
                severity: "error",
                code: "timeline_not_paused",
                message: "timeline must be paused",
                file: "compositions/frames/02-value.html",
              },
            ],
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: JSON.stringify({ findings: [] }), stderr: "" };
    }
    // sync-durations / fetch-sfx / wait-bgm / captions / stage-assets / transitions
    return ok;
  };
}

async function makeEngine(options?: {
  storyboardFirstBroken?: boolean;
  lintErrorOnce?: boolean;
}): Promise<{
  engine: SessionEngine;
  record: SessionRecord;
  store: MemStore;
  calls: string[];
  spawnLog: SpawnLogEntry[];
  dispatched: unknown[];
}> {
  const store = new MemStore();
  const record = await createSessionRecord(store, {
    id: "ses_test1",
    userId: "usr_1",
    url: "https://amroagents.com",
  });
  const { client, calls } = mockInteractions(options);
  const spawnLog: SpawnLogEntry[] = [];
  const dispatched: unknown[] = [];
  const deps: SessionDeps = {
    store,
    skills: new SkillLoader(),
    interactions: client,
    dispatchRender: async (body) => {
      dispatched.push(body);
      return { render_id: "hf-render-test" };
    },
    readRenderStatus: async () => ({ status: "completed", video_url: "https://signed/video.mp4" }),
    cliPath: "/fake/cli.js",
    geminiApiKey: "test-key",
    runShellCommand: mockSpawn(spawnLog, options),
    workerConcurrency: 2,
    timing: { audioWaitMs: 5000, renderPollIntervalMs: 5, renderPollTimeoutMs: 1000 },
  };
  return { engine: new SessionEngine(record, deps), record, store, calls, spawnLog, dispatched };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("SkillLoader", () => {
  it("resolves the repo skills root and lists presets, rules, blueprints", () => {
    const skills = new SkillLoader();
    expect(skills.listFramePresets().map((p) => p.name)).toContain("capsule");
    expect(skills.listRuleIds()).toContain("spring-pop-entrance");
    expect(skills.listBlueprintIds()).toContain("titlecard-reveal");
  });

  it("falls back to the hyperframes-core twin for docs the rebrand missed", () => {
    const skills = new SkillLoader();
    expect(skills.storyboardContext()).toContain("SCRIPT.md");
    expect(skills.storyboardContext()).toContain("script-format.md");
  });

  it("finds rule recipes cited in a frame block", () => {
    const skills = new SkillLoader();
    const cited = skills.rulesCitedIn("reveal cards with spring-pop-entrance then hold");
    expect(cited.map((r) => r.id)).toEqual(["spring-pop-entrance"]);
  });
});

describe("storyboard helpers", () => {
  it("validateStoryboard flags missing src/duration and too-few frames", () => {
    expect(
      validateStoryboard({
        globals: { extra: {} },
        frames: [{ index: 0, status: "outline", narrative: "", extra: {}, scene: "x" }],
        warnings: [],
      } as never),
    ).toEqual([
      "only 1 frames (need at least 3)",
      "frame 1: missing duration",
      "frame 1: missing src (compositions/frames/NN-*.html)",
    ]);
  });

  it("frameId prefers the storyboard src basename", () => {
    expect(frameId({ src: "compositions/frames/03-proof.html" } as never, 5)).toBe("03-proof");
    expect(frameId({ title: "The Hook!" } as never, 0)).toBe("01-the-hook");
  });

  it("extractFrameBlock returns exactly one frame's section", () => {
    const block = extractFrameBlock(STORYBOARD, {} as never, 1);
    expect(block).toContain("## Frame 2 — Value");
    expect(block).toContain("02-value.html");
    expect(block).not.toContain("## Frame 3");
  });

  it("parseLintFindings tolerates leading noise and both shapes", () => {
    expect(
      parseLintFindings('linting...\n{"findings":[{"severity":"error","message":"m"}]}'),
    ).toEqual([{ severity: "error", code: undefined, message: "m", file: undefined }]);
    expect(parseLintFindings("[]")).toEqual([]);
    expect(parseLintFindings("no json at all")).toEqual([]);
  });
});

describe("SessionEngine full run", () => {
  it("drives all steps to done and completes with a video URL", async () => {
    const { engine, store, calls, dispatched } = await makeEngine();
    const result = await engine.runAll();

    expect(result.status).toBe("completed");
    expect(result.video_url).toBe("https://signed/video.mp4");
    expect(result.render_id).toBe("hf-render-test");
    const states = Object.fromEntries(result.tasks.map((t) => [t.id, t.state]));
    expect(states).toEqual({
      "step-0-setup": "done",
      "step-1-capture": "done",
      "step-2-frame": "done",
      "step-3-storyboard": "done",
      "step-3.1-audio": "done",
      "step-4-visual": "done",
      "step-5-build": "done",
      "step-6-finalize": "done",
      "step-7-deliver": "done",
    });
    // One brief + one preset + one storyboard + one visual + 4 workers.
    expect(calls.filter((c) => c === "worker")).toHaveLength(4);
    expect(calls).toContain("brief");
    // The render was dispatched exactly once, as a base64 zip of the project.
    expect(dispatched).toHaveLength(1);
    const body = dispatched[0] as {
      project: { type: string };
      aspect_ratio: string;
      quality: string;
    };
    expect(body.project.type).toBe("base64");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.quality).toBe("high");
    // The persisted record matches the returned one.
    const persisted = (await store.read<SessionRecord>(sessionKey("ses_test1"))) as SessionRecord;
    expect(persisted.status).toBe("completed");
    expect(persisted.usage.calls).toBeGreaterThanOrEqual(0);
    expect(persisted.chat.length).toBeGreaterThanOrEqual(6);
  });

  it("repairs a storyboard that fails validation once", async () => {
    const { engine, calls } = await makeEngine({ storyboardFirstBroken: true });
    const result = await engine.runAll();
    expect(result.status).toBe("completed");
    expect(calls.filter((c) => c.startsWith("storyboard#"))).toEqual([
      "storyboard#1",
      "storyboard#2",
    ]);
  });

  it("re-dispatches only the frame a lint error names, then passes", async () => {
    const { engine, calls } = await makeEngine({ lintErrorOnce: true });
    const result = await engine.runAll();
    expect(result.status).toBe("completed");
    // 4 initial workers + exactly 1 retry for 02-value.
    expect(calls.filter((c) => c === "worker")).toHaveLength(5);
  });

  it("marks the session failed with the failing step when a gate breaks", async () => {
    const { engine, record } = await makeEngine();
    // Sabotage: make dispatchRender explode.
    (engine as unknown as { deps: SessionDeps }).deps.dispatchRender = async () => {
      throw new Error("quota exceeded");
    };
    const result = await engine.runAll();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("step-6-finalize");
    expect(record.tasks.find((t) => t.id === "step-6-finalize")?.state).toBe("failed");
    expect(record.tasks.find((t) => t.id === "step-7-deliver")?.state).toBe("pending");
  });

  it("writes frame HTML to the storyboard's src paths and marks frames animated", async () => {
    const { engine } = await makeEngine();
    await engine.runAll();
    const projectDir = (engine as unknown as { projectDir: string }).projectDir;
    for (const rel of [
      "compositions/frames/01-hook.html",
      "compositions/frames/02-value.html",
      "compositions/frames/03-proof.html",
      "compositions/frames/04-cta.html",
    ]) {
      expect(existsSync(join(projectDir, rel))).toBe(true);
    }
    const board = readFileSync(join(projectDir, "STORYBOARD.md"), "utf8");
    expect(board.match(/- status: animated/g)).toHaveLength(4);
    expect(board).not.toContain("- status: outline");
  });
});
