/**
 * Minimal Gemini Interactions API client — REST over global fetch, zero SDK
 * (same philosophy as ../gemini.ts, which wraps the older generateContent
 * surface). The Interactions API is Gemini's agentic endpoint: one POST per
 * turn, chainable via `previous_interaction_id`, response as `steps[]` whose
 * final `model_output` step carries the text.
 *
 * Verified live against gemini-3-flash-preview:
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   headers: x-goog-api-key
 *   body: { model, input, system_instruction?, previous_interaction_id?,
 *           generation_config: { temperature, max_output_tokens, thinking_level } }
 *   → { id, status: "completed", usage: {...}, steps: [{type:"thought"...},
 *       {type:"model_output", content:[{type:"text", text}]}] }
 */

import { DEFAULT_GEMINI_MODEL, GeminiError, stripCodeFence } from "../gemini.js";
import type { ThinkingLevel } from "../gemini.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 300_000;

export interface InteractOptions {
  input: string;
  systemInstruction?: string;
  previousInteractionId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  thinkingLevel?: ThinkingLevel;
  /** Override the client's model for this one call. */
  model?: string;
}

export interface InteractResult {
  text: string;
  interactionId: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface InteractionsUsageSink {
  record(usage: { input_tokens: number; output_tokens: number }): void;
}

interface InteractionsResponse {
  id?: string;
  status?: string;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
  steps?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

export class InteractionsClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly usageSink?: InteractionsUsageSink;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    usageSink?: InteractionsUsageSink;
  }) {
    if (!options.apiKey) throw new GeminiError("GEMINI_API_KEY is not configured");
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_GEMINI_MODEL;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.usageSink = options.usageSink;
  }

  async interact(options: InteractOptions): Promise<InteractResult> {
    const body: Record<string, unknown> = {
      model: `models/${options.model || this.model}`,
      input: options.input,
      generation_config: {
        temperature: options.temperature ?? 0.5,
        max_output_tokens: options.maxOutputTokens ?? 16384,
        ...(options.thinkingLevel ? { thinking_level: options.thinkingLevel } : {}),
      },
    };
    if (options.systemInstruction) body["system_instruction"] = options.systemInstruction;
    if (options.previousInteractionId) {
      body["previous_interaction_id"] = options.previousInteractionId;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new GeminiError(`Interactions request failed: ${(err as Error).message}`, err);
    } finally {
      clearTimeout(timer);
    }

    const data = (await res.json().catch(() => ({}))) as InteractionsResponse;
    if (!res.ok || data.error) {
      throw new GeminiError(
        `Interactions API error (${res.status}): ${data.error?.message ?? res.statusText}`,
        data,
      );
    }
    // "incomplete" = the reply hit max_output_tokens (thought tokens count
    // against the same budget) — the text is truncated mid-file and must
    // not be used. Callers' retry loops treat this like any other failure.
    if (data.status === "incomplete") {
      throw new GeminiError(
        "Interactions reply truncated (max_output_tokens exhausted, including thought tokens) — retry or raise the budget",
        data,
      );
    }
    const output = (data.steps ?? []).filter((s) => s.type === "model_output");
    const text = output
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
    if (!text) {
      throw new GeminiError(
        `Interactions response had no model_output text (status ${data.status ?? "?"})`,
        data,
      );
    }
    const usage = {
      input_tokens: data.usage?.total_input_tokens ?? 0,
      output_tokens: data.usage?.total_output_tokens ?? 0,
    };
    this.usageSink?.record(usage);
    return { text: stripCodeFence(text), interactionId: data.id ?? "", usage };
  }

  /** JSON-shaped interaction: parses the reply, throws GeminiError on bad JSON. */
  async interactJson<T>(options: InteractOptions): Promise<{ value: T } & InteractResult> {
    const result = await this.interact(options);
    try {
      return { ...result, value: JSON.parse(result.text) as T };
    } catch (err) {
      throw new GeminiError(
        `Interactions returned invalid JSON: ${(err as Error).message}`,
        result.text,
      );
    }
  }
}
