/**
 * KENECT Sessions — shared types for the skill-following video orchestrator.
 *
 * A session is one URL→video production run executed by the step machine in
 * orchestrator.ts, which follows skills/product-launch-video/SKILL.md's
 * steps and gates. The record below is the single source of truth for the
 * MCP tools and the web session page (tasks board + chat log + renders).
 */

/** Stable step ids — these are the task rows the session UI renders. */
export const SESSION_STEPS = [
  "step-0-setup",
  "step-1-capture",
  "step-2-frame",
  "step-3-storyboard",
  "step-3.1-audio",
  "step-4-visual",
  "step-5-build",
  "step-6-finalize",
  "step-7-deliver",
] as const;

export type SessionStepId = (typeof SESSION_STEPS)[number];

export type TaskState = "pending" | "running" | "done" | "failed" | "skipped";

export interface SessionTask {
  id: SessionStepId;
  /** Short human title shown in the tasks panel. */
  title: string;
  state: TaskState;
  /** One-line progress / result / error note. */
  note?: string;
  started_at?: number;
  finished_at?: number;
}

export interface SessionChatMessage {
  role: "agent" | "user" | "system";
  text: string;
  ts: number;
}

export interface SessionBrief {
  /** Story angle, e.g. "capability montage" — skill Step 0 Round 2. */
  angle: string;
  /** Total video length in seconds (30–90 sweet spot). */
  length_s: number;
  /** Destination → aspect (16:9 / 1:1 / 9:16). */
  destination: string;
  aspect: "16:9" | "1:1" | "9:16";
  /** The ONE thing the promo must communicate. */
  message: string;
  language: string;
}

export type SessionStatus = "queued" | "running" | "completed" | "failed";

export interface SessionRecord {
  id: string;
  user_id: string;
  url: string;
  status: SessionStatus;
  brief?: SessionBrief;
  tasks: SessionTask[];
  chat: SessionChatMessage[];
  /** Set at step-6 when the distributed render is dispatched. */
  render_id?: string;
  /** Signed MP4 URL, set at step-7 on render completion. */
  video_url?: string;
  /** Cumulative Gemini token usage for cost telemetry. */
  usage: { calls: number; input_tokens: number; output_tokens: number };
  error?: string;
  created_at: number;
  updated_at: number;
}

export const STEP_TITLES: Record<SessionStepId, string> = {
  "step-0-setup": "Set up the project and lock the brief",
  "step-1-capture": "Capture website snapshots and assets",
  "step-2-frame": "Create a branded design document",
  "step-3-storyboard": "Draft the project storyboard and script",
  "step-3.1-audio": "Create audio and music for the video",
  "step-4-visual": "Design each frame's shot sequence",
  "step-5-build": "Build and assemble the final composition",
  "step-6-finalize": "Validate, inject transitions, and render",
  "step-7-deliver": "Final review and project delivery",
};

export function newSessionTasks(): SessionTask[] {
  return SESSION_STEPS.map((id) => ({ id, title: STEP_TITLES[id], state: "pending" }));
}

export function sessionKey(id: string): string {
  return `sessions/${id}.json`;
}

export function userSessionsKey(userId: string): string {
  return `user_sessions/${userId}.json`;
}

export interface UserSessionsIndex {
  sessions: Array<{ id: string; url: string; status: SessionStatus; created_at: number }>;
}
