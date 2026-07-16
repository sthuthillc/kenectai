/**
 * Skill content loader — the bridge that makes the orchestrator's Gemini
 * calls "follow the skills": each judgment step's prompt context is
 * assembled from the exact reference docs the skill's SKILL.md tells the
 * agent to read at that step, loaded verbatim from the skills/ tree.
 *
 * The skills root resolves from KENECT_SKILLS_DIR, else by walking upward
 * from this module until `skills/product-launch-video/SKILL.md` is found
 * (repo dev: <repo>/skills; container: /app/skills).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class SkillLoaderError extends Error {}

const PLV = "product-launch-video";

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function resolveSkillsRoot(): string {
  const fromEnv = process.env["KENECT_SKILLS_DIR"]?.trim();
  if (fromEnv) {
    if (!existsSync(join(fromEnv, PLV, "SKILL.md"))) {
      throw new SkillLoaderError(`KENECT_SKILLS_DIR=${fromEnv} does not contain ${PLV}/SKILL.md`);
    }
    return resolve(fromEnv);
  }
  let dir = moduleDir();
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "skills");
    if (existsSync(join(candidate, PLV, "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new SkillLoaderError(
    "Could not locate the skills/ directory (set KENECT_SKILLS_DIR or run inside the monorepo)",
  );
}

export class SkillLoader {
  readonly root: string;
  private readonly cache = new Map<string, string>();

  constructor(root?: string) {
    this.root = root ?? resolveSkillsRoot();
  }

  /** Absolute path of a skills-relative file (e.g. "product-launch-video/SKILL.md"). */
  path(rel: string): string {
    return join(this.root, rel);
  }

  /** Read a skills-relative file, cached. Throws SkillLoaderError when missing. */
  read(rel: string): string {
    const cached = this.cache.get(rel);
    if (cached !== undefined) return cached;
    const abs = this.path(rel);
    if (!existsSync(abs)) throw new SkillLoaderError(`skill file missing: ${rel}`);
    const content = readFileSync(abs, "utf8");
    this.cache.set(rel, content);
    return content;
  }

  /** Read a skills-relative file, or return null when absent (optional docs). */
  tryRead(rel: string): string | null {
    try {
      return this.read(rel);
    } catch {
      return null;
    }
  }

  /**
   * Concatenate several skill docs into one prompt-context block, each
   * introduced with its path so the model can cite where a rule came from.
   * Each entry may be a single path or a fallback list (first existing
   * wins) — a few docs were missed by the kenectai-* skill rebrand and
   * still only exist under their hyperframes-* twin.
   */
  docBundle(rels: Array<string | string[]>): string {
    return rels
      .map((entry) => {
        const candidates = Array.isArray(entry) ? entry : [entry];
        for (const rel of candidates) {
          const body = this.tryRead(rel);
          if (body !== null) return `\n\n===== ${rel} =====\n\n${body}`;
        }
        return "";
      })
      .join("")
      .trim();
  }

  /** Frame preset names + their FRAME.md frontmatter description snippet. */
  listFramePresets(): Array<{ name: string; description: string }> {
    const dir = this.path("kenectai-creative/frame-presets");
    if (!existsSync(dir)) return [];
    const presets: Array<{ name: string; description: string }> = [];
    for (const name of readdirSync(dir).sort()) {
      const frame = join(dir, name, "FRAME.md");
      if (!existsSync(frame)) continue;
      const head = readFileSync(frame, "utf8").slice(0, 1600);
      const desc = /description:\s*>?\s*\n?([\s\S]*?)\n[a-z_]+:/.exec(head)?.[1] ?? "";
      presets.push({ name, description: desc.replace(/\s+/g, " ").trim().slice(0, 400) });
    }
    return presets;
  }

  /** All motion-rule ids (rule file basenames without .md). */
  listRuleIds(): string[] {
    const dir = this.path("kenectai-animation/rules");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  /** All blueprint ids. */
  listBlueprintIds(): string[] {
    const dir = this.path("kenectai-animation/blueprints");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  }

  // ── per-step context assemblies (the SKILL.md "Read" lists, verbatim) ────

  /** Step 3 (storyboard + script authoring) context. */
  storyboardContext(): string {
    return this.docBundle([
      "kenectai-creative/references/story-spine.md",
      `${PLV}/references/story-design.md`,
      "kenectai-animation/blueprints-index.md",
      "kenectai-core/references/storyboard-format.md",
      ["kenectai-core/references/script-format.md", "hyperframes-core/references/script-format.md"],
    ]);
  }

  /** Step 2 (preset choice) context. */
  designSpecContext(): string {
    return this.docBundle(["kenectai-creative/references/design-spec.md"]);
  }

  /** Step 4 (frame visual design enrichment) context. */
  visualDesignContext(): string {
    return this.docBundle([
      `${PLV}/references/visual-design.md`,
      `${PLV}/references/motion-language.md`,
      "kenectai-animation/blueprints-index.md",
      "kenectai-animation/rules-index.md",
    ]);
  }

  /** Step 5 frame-worker structural contract (kenectai-core composition law). */
  coreCompositionContract(): string {
    return this.docBundle([
      "kenectai-core/references/minimal-composition.md",
      "kenectai-core/references/sub-compositions.md",
      "kenectai-core/references/tracks-and-clips.md",
      "kenectai-core/references/data-attributes.md",
      "kenectai-core/references/determinism-rules.md",
    ]);
  }

  /** The frame-worker system prompt (sub-agents/frame-worker.md). */
  frameWorkerPrompt(): string {
    return this.read(`${PLV}/sub-agents/frame-worker.md`);
  }

  /** The cut catalog referenced by the frame worker. */
  cutCatalog(): string {
    return this.read(`${PLV}/references/cut-catalog.md`);
  }

  /** A blueprint body by id; null when the id is `compose` or unknown. */
  blueprint(id: string): string | null {
    if (!id || id === "compose") return null;
    return this.tryRead(`kenectai-animation/blueprints/${id}.md`);
  }

  /** Rule recipe bodies for every rule id mentioned in `text`. */
  rulesCitedIn(text: string): Array<{ id: string; body: string }> {
    const out: Array<{ id: string; body: string }> = [];
    for (const id of this.listRuleIds()) {
      if (text.includes(id)) {
        const body = this.tryRead(`kenectai-animation/rules/${id}.md`);
        if (body) out.push({ id, body });
      }
    }
    return out;
  }
}
