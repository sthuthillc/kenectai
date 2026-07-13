/**
 * Minimal Gemini API client — REST over global fetch, zero SDK dependency
 * (matches the rest of this package: node:crypto for oauthServer, no
 * unnecessary wrappers). Text and structured-JSON generation only; this is
 * the "brain" for the product routes in ./products/*.
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 90_000;

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

interface GenerateOptions {
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(options: GeminiClientOptions) {
    if (!options.apiKey) {
      throw new GeminiError("GEMINI_API_KEY is not configured on this deployment");
    }
    this.apiKey = options.apiKey;
    this.model = options.model || DEFAULT_MODEL;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  }

  /** Free-form text generation (markdown, HTML, prose). */
  async generateText(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const body = this.buildRequestBody(prompt, options);
    const data = await this.call(body);
    return this.extractText(data);
  }

  /**
   * Structured JSON generation. `schemaHint` is appended to the prompt as a
   * plain-language description of the required shape — Gemini's JSON mode
   * (`responseMimeType: application/json`) constrains syntax, not the shape,
   * so the prompt still has to carry the contract.
   */
  async generateJson<T>(prompt: string, options: GenerateOptions = {}): Promise<T> {
    const body = this.buildRequestBody(prompt, options);
    body.generationConfig.responseMimeType = "application/json";
    const data = await this.call(body);
    const text = this.extractText(data);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new GeminiError(`Gemini returned invalid JSON: ${(err as Error).message}`, text);
    }
  }

  private buildRequestBody(prompt: string, options: GenerateOptions) {
    const body: {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>;
      generationConfig: { temperature: number; maxOutputTokens: number; responseMimeType?: string };
      systemInstruction?: { parts: Array<{ text: string }> };
    } = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.5,
        maxOutputTokens: options.maxOutputTokens ?? 8192,
      },
    };
    if (options.systemInstruction) {
      body.systemInstruction = { parts: [{ text: options.systemInstruction }] };
    }
    return body;
  }

  private async call(body: unknown): Promise<GeminiResponse> {
    const url = `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as GeminiResponse | null;
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? JSON.stringify((payload as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new GeminiError(`Gemini API request failed: ${message}`);
      }
      if (!payload) throw new GeminiError("Gemini API returned an empty response");
      return payload;
    } catch (err) {
      if (err instanceof GeminiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GeminiError(`Gemini API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new GeminiError("Gemini API request failed", err);
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractText(data: GeminiResponse): string {
    if (data.promptFeedback?.blockReason) {
      throw new GeminiError(`Gemini blocked the request: ${data.promptFeedback.blockReason}`);
    }
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      throw new GeminiError(
        `Gemini returned no usable text (finishReason: ${candidate?.finishReason ?? "unknown"})`,
      );
    }
    return text;
  }
}

/** Strips accidental ```lang ... ``` fences some models wrap raw output in. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}
