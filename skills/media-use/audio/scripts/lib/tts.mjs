// tts.mjs — multi-provider TTS for the media audio engine. The provider chain,
// auto-detected from env, is the one documented in ../SKILL.md:
//
//   1. HeyGen (Starfish)  — $HEYGEN_API_KEY / $KENECT_API_KEY / ~/.heygen.
//        Direct v3 REST (NOT `kenectai tts`, which in the published build is
//        Kokoro-only and silently ignores a HeyGen key). Returns word_timestamps
//        in the same call, so no separate transcribe pass.
//   2. Gemini native TTS  — $GEMINI_API_KEY / $GOOGLE_API_KEY. Direct REST
//        against the Interactions API (generativelanguage.googleapis.com/v1beta/
//        interactions, model gemini-3.1-flash-tts-preview), zero SDK/pip
//        dependency. No word timings → caller chains transcribeWav(). Ranked
//        ahead of ElevenLabs since it's first-party Google infra, consistent
//        with the rest of this project's model stack.
//   3. ElevenLabs         — $ELEVENLABS_API_KEY + `pip install elevenlabs`. No
//        word timings → caller chains transcribeWav().
//   4. Kokoro-82M (local) — always available, via the published `kenectai tts`
//        CLI. No word timings → caller chains transcribeWav().
//
// "HeyGen available" is decided by CREDENTIAL presence (heygenCredential), never
// by the CLI — see the note above.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { heygenAuthHeaders, heygenCredential, heygenJSON } from "./heygen.mjs";
import { pythonInvocation } from "./python.mjs";

// ── provider detection ────────────────────────────────────────────────────────
export function heygenAvailable() {
  return heygenCredential() !== null;
}
export function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
}
export function geminiAvailable() {
  return geminiApiKey() !== "";
}
export function elevenlabsAvailable() {
  if (!process.env.ELEVENLABS_API_KEY) return false;
  const { cmd, args } = pythonInvocation(["-c", "import elevenlabs"]);
  const r = spawnSync(cmd, args, {
    stdio: "ignore",
  });
  return r.status === 0;
}

// First available provider wins; an explicit choice is honored (and validated).
export function pickProvider(userProvider) {
  if (userProvider) {
    if (!["heygen", "gemini", "elevenlabs", "kokoro"].includes(userProvider))
      throw new Error(`invalid provider "${userProvider}" (heygen | gemini | elevenlabs | kokoro)`);
    if (userProvider === "heygen" && !heygenAvailable())
      throw new Error(
        "provider=heygen but no HeyGen credentials (set $HEYGEN_API_KEY or run `npx @kenectai/cli auth login`)",
      );
    if (userProvider === "gemini" && !geminiAvailable())
      throw new Error("provider=gemini but neither $GEMINI_API_KEY nor $GOOGLE_API_KEY is set");
    if (userProvider === "elevenlabs" && !process.env.ELEVENLABS_API_KEY)
      throw new Error("provider=elevenlabs but $ELEVENLABS_API_KEY is not set");
    return userProvider;
  }
  return heygenAvailable()
    ? "heygen"
    : geminiAvailable()
      ? "gemini"
      : elevenlabsAvailable()
        ? "elevenlabs"
        : "kokoro";
}

// ── voice resolution ──────────────────────────────────────────────────────────
// HeyGen /v3/voices/speech only accepts STARFISH voice_ids; auto-pick the first
// English public starfish voice when none is pinned. ElevenLabs/Kokoro have
// their own defaults.
export async function resolveVoiceId({ provider, userVoice, lang = "en" }) {
  if (userVoice) return userVoice;
  if (provider === "elevenlabs") return "21m00Tcm4TlvDq8ikWAM"; // Rachel
  if (provider === "gemini") return "Kore"; // fixed default prebuilt voice — deterministic
  if (provider === "kokoro") {
    if (lang === "en") return "am_michael";
    throw new Error("Kokoro non-English needs an explicit --voice (see references/tts.md)");
  }
  // heygen — pin a fixed English default so the choice is deterministic. The old
  // "first English voice the API returns" drifts whenever HeyGen re-sorts the
  // public catalog. Marcia (mature, low female). Override with --voice / request.voice.
  if (lang === "en") return "05f19352e8f74b0392a8f411eba40de1"; // Marcia · English · female
  // Non-English: no fixed default — fall back to the first matching catalog voice.
  const payload = await heygenJSON(`/voices?engine=starfish&type=public&limit=50`, {
    headers: heygenAuthHeaders(),
  });
  const voices = payload.data ?? payload.voices ?? [];
  const pick = voices.find((v) => v.language === "English") ?? voices[0];
  if (!pick) throw new Error("no public starfish voice to default to — pass --voice");
  return pick.voice_id;
}

// ── helpers ─────────────────────────────────────────────────────────────────
export function withWordIds(words) {
  return (words ?? []).map((w, i) => ({
    id: `w${i}`,
    text: w.text,
    start: w.start,
    end: w.end,
  }));
}

// `ffmpeg -i <file>` prints a `Duration: HH:MM:SS.ms` line to stderr even
// though it exits non-zero with no output requested. Parsing pulled out as
// a pure function so the ENOENT fallback below can be tested without
// depending on whether ffprobe/ffmpeg are actually installed on the
// machine running the tests.
export function parseFfmpegDurationBanner(stderrText) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderrText ?? "");
  if (!match) return NaN;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// Some "essentials"-style ffmpeg distributions (common on Windows) ship
// ffmpeg.exe without ffprobe.exe. ffprobeDuration's caller (audio.mjs)
// otherwise reads a spurious NaN as "the WAV file is corrupt" and drops an
// already-successfully-synthesized TTS line, rather than "the tool for
// measuring it is missing".
function ffmpegDurationFallback(absPath) {
  const r = spawnSync("ffmpeg", ["-i", absPath], { encoding: "utf8" });
  return parseFfmpegDurationBanner(r.stderr);
}

export function ffprobeDuration(absPath) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", absPath],
    { encoding: "utf8" },
  );
  if (r.error?.code === "ENOENT") return ffmpegDurationFallback(absPath);
  if (r.status !== 0) return NaN;
  return parseFloat(String(r.stdout).trim());
}

export function resolveNpxCliFromNpmExecPath(
  npmExecPath = process.env.npm_execpath,
  pathExists = existsSync,
) {
  if (!npmExecPath) return null;
  const fileName = npmExecPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const npxCliPath =
    fileName === "npx-cli.js" ? npmExecPath : join(dirname(npmExecPath), "npx-cli.js");
  return pathExists(npxCliPath) ? npxCliPath : null;
}

export function resolveNpxCliPath(
  npmExecPath = process.env.npm_execpath,
  nodeExecPath = process.env.npm_node_execpath || process.execPath,
  pathExists = existsSync,
) {
  const fromNpm = resolveNpxCliFromNpmExecPath(npmExecPath, pathExists);
  if (fromNpm) return fromNpm;
  const besideNode = join(dirname(nodeExecPath), "node_modules", "npm", "bin", "npx-cli.js");
  return pathExists(besideNode) ? besideNode : null;
}

export function resolveSpawnCommand(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  env = process.env,
  pathExists = existsSync,
) {
  if (cmd !== "npx" || platform !== "win32") {
    return { cmd, args, opts: { stdio: "ignore", ...opts } };
  }

  // On Windows, npx resolves to npx.cmd, which Node cannot execute directly.
  // Avoid `shell:true` and the .cmd shim entirely by invoking npm's JS CLI with
  // node, preserving request-provided values as argv data instead of shell text.
  const nodeExecPath = env.npm_node_execpath || process.execPath;
  const npxCliPath = resolveNpxCliPath(env.npm_execpath, nodeExecPath, pathExists);
  if (!npxCliPath) return null;
  return {
    cmd: nodeExecPath,
    args: [npxCliPath, ...args.map((arg) => String(arg))],
    opts: { stdio: "ignore", windowsHide: true, ...opts },
  };
}

// `platform`/`spawnFn` params (default process.platform / the real spawn)
// exist so tests can exercise the win32 branch without mocking node:child_process
// (its ESM exports are non-configurable, so mock.method can't patch it).
// One-shot so a whole batch of TTS lines doesn't repeat the same diagnostic.
let _warnedNpxResolution = false;
/** Test-only: reset the one-shot npx-resolution warning latch. */
export function _resetNpxResolutionWarnForTests() {
  _warnedNpxResolution = false;
}

export function spawnP(
  cmd,
  args,
  opts = {},
  platform = process.platform,
  spawnFn = spawn,
  env = process.env,
  pathExists = existsSync,
) {
  const resolved = resolveSpawnCommand(cmd, args, opts, platform, env, pathExists);
  if (!resolved) {
    // resolveSpawnCommand only returns null for the npx-on-win32 case where
    // neither npm's configured CLI nor the beside-node fallback exists. Without
    // this, every call silently returns status:-1 and stdio:"ignore" hides why.
    if (!_warnedNpxResolution) {
      _warnedNpxResolution = true;
      const reason = env.npm_execpath
        ? `npm_execpath (${env.npm_execpath}) and the beside-node npm fallback could not be found`
        : "npm_execpath is unset and the beside-node npm fallback could not be found";
      console.error(
        `[media-use] Cannot run "${cmd}" on Windows: ${reason}. ` +
          `Every "${cmd}" call is being skipped. Install npm with Node, or run via ` +
          `\`npx\`/\`npm run\` with a valid npm_execpath.`,
      );
    }
    return Promise.resolve({ status: -1 });
  }
  return new Promise((resolve) => {
    const p = spawnFn(resolved.cmd, resolved.args, resolved.opts);
    p.on("exit", (code) => resolve({ status: code ?? -1 }));
    p.on("error", () => resolve({ status: -1 }));
  });
}

// mp3/whatever bytes → wav 44.1k mono at destWav (ffmpeg detects true format).
function transcodeToWav(bytes, destWav) {
  const td = mkdtempSync(join(tmpdir(), "hf-tts-"));
  const tmp = join(td, "a.mp3");
  writeFileSync(tmp, bytes);
  mkdirSync(dirname(destWav), { recursive: true });
  const ff = spawnSync(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-i", tmp, "-ar", "44100", "-ac", "1", destWav],
    { stdio: "ignore" },
  );
  rmSync(td, { recursive: true, force: true });
  return ff.status === 0 && existsSync(destWav);
}

const ELEVENLABS_PY = `
import os, sys
from elevenlabs.client import ElevenLabs
from elevenlabs import save
client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
text = open(sys.argv[1]).read()
audio = client.text_to_speech.convert(
    text=text, voice_id=sys.argv[2],
    model_id="eleven_multilingual_v2", output_format="mp3_44100_128",
)
save(audio, sys.argv[3])
`;

// ── synthesize one line ───────────────────────────────────────────────────────
// Writes wav at wavAbs. Returns { ok, words, error } — words is the raw
// [{text,start,end}] array for HeyGen (native), or null for ElevenLabs/Kokoro
// (caller must transcribeWav). Never throws; failures return { ok:false, error }
// where `error` states WHY (so the caller can surface it, not a bare "TTS failed").
export async function synthesizeOne({
  provider,
  text,
  voiceId,
  lang = "en",
  speed = 1.0,
  wavAbs,
  kenectaiDir,
}) {
  if (provider === "heygen") return synthesizeHeygen({ text, voiceId, lang, speed, wavAbs });
  if (provider === "gemini") return synthesizeGemini({ text, voiceId, lang, wavAbs });
  if (provider === "elevenlabs") {
    // The Python helper writes straight to wavAbs; unlike heygen (transcodeToWav)
    // and kokoro (the `kenectai tts` CLI), it does NOT create the parent dir,
    // so on a fresh project (no assets/voice/ yet) the save fails and the line is
    // silently dropped as "TTS failed - omitted". Create it first, like the other
    // providers do. Guarded so a mkdir failure (EACCES/EROFS) returns
    // { ok:false } like the rest of this branch rather than throwing (the
    // function's contract is "never throws; failures return { ok:false }").
    try {
      mkdirSync(dirname(wavAbs), { recursive: true });
    } catch {
      return { ok: false, words: null };
    }
    const { cmd, args } = pythonInvocation([
      "-c",
      ELEVENLABS_PY,
      writeTmpText(text),
      voiceId,
      wavAbs,
    ]);
    const r = await spawnP(cmd, args, {});
    return synthResult(r, wavAbs, "elevenlabs (python)");
  }
  // kokoro — via the published CLI; --output is relative to the project dir.
  const wavRel = relTo(kenectaiDir, wavAbs);
  const args = ["kenectai", "tts", writeTmpText(text), "--voice", voiceId, "--output", wavRel];
  if (lang !== "en") args.push("--lang", lang);
  const r = await spawnP("npx", args, { cwd: kenectaiDir });
  return synthResult(r, wavAbs, "kokoro (npx @kenectai/cli tts)");
}

// Shape a spawn result into { ok, words, error }, naming why on failure so the
// caller surfaces it instead of a bare "TTS failed".
export function synthResult(r, wavAbs, label) {
  if (r.status === 0 && existsSync(wavAbs)) return { ok: true, words: null };
  const why =
    r.status !== 0 ? `${label} exited with status ${r.status}` : `${label} produced no wav file`;
  return { ok: false, words: null, error: why };
}

// `deps` is injectable for tests; production uses the real network/ffmpeg impls.
// Every failure path returns an `error` string so the caller can surface WHY a
// line was dropped instead of the bare "TTS failed" that hid the real cause
// (e.g. an HTTP 402 plan_upgrade_required thrown by heygenJSON was swallowed).
export async function synthesizeHeygen({ text, voiceId, lang, speed, wavAbs }, deps = {}) {
  const requestJSON = deps.heygenJSON ?? heygenJSON;
  const authHeaders = deps.heygenAuthHeaders ?? heygenAuthHeaders;
  const fetchImpl = deps.fetch ?? fetch;
  const transcode = deps.transcodeToWav ?? transcodeToWav;
  try {
    const body = { text, voice_id: voiceId, speed };
    if (lang !== "en") body.language = lang;
    const payload = await requestJSON(`/voices/speech`, {
      method: "POST",
      headers: authHeaders(),
      body,
    });
    const inner = payload.data ?? payload;
    if (!inner.audio_url) {
      return { ok: false, words: null, error: "HeyGen /voices/speech returned no audio_url" };
    }
    const res = await fetchImpl(inner.audio_url);
    if (!res.ok) {
      return { ok: false, words: null, error: `audio_url fetch failed: HTTP ${res.status}` };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    // .wav output → transcode to 44.1k mono; .mp3 → raw bytes (no ffmpeg). The
    // engine always asks for .wav; the standalone heygen-tts CLI may ask for .mp3.
    if (wavAbs.endsWith(".wav")) {
      if (!transcode(bytes, wavAbs)) {
        return {
          ok: false,
          words: null,
          error: "wav transcode failed (ffmpeg)",
        };
      }
    } else {
      mkdirSync(dirname(wavAbs), { recursive: true });
      writeFileSync(wavAbs, bytes);
    }
    const words = Array.isArray(inner.word_timestamps)
      ? inner.word_timestamps
          .filter((w) => w && typeof w.word === "string" && isFinite(w.start) && isFinite(w.end))
          .filter((w) => !/^<.*>$/.test(w.word.trim())) // drop <start>/<end> sentinels
          .map((w) => ({ text: w.word, start: w.start, end: w.end }))
      : [];
    return { ok: true, words };
  } catch (e) {
    return { ok: false, words: null, error: e?.message ? String(e.message) : String(e) };
  }
}

// Gemini's Interactions API endpoint + model. Native speech generation — REST
// only, no google-genai SDK dependency (unlike lyria-recipe.py's old live-session
// path, this is a single-shot HTTP call).
export const GEMINI_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";
export const GEMINI_TTS_MODEL = "gemini-3.1-flash-tts-preview";

// Wrap headerless raw PCM (16-bit signed LE) in a minimal WAV container so
// transcodeToWav's ffmpeg call can sniff and resample it. Only needed when
// output_audio.mime_type reports a raw codec (audio/L16, audio/pcm, …) rather
// than an already-boxed format (wav/mp3) ffmpeg can sniff on its own.
export function pcm16ToWav(pcmBytes, sampleRate, channels) {
  const dataSize = pcmBytes.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate (16-bit)
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBytes]);
}

// mime_type → sample_rate parsed from "audio/L16;codec=pcm;rate=24000" style
// strings the Interactions API uses for raw PCM. Falls back to the response's
// own sample_rate field, then 24000 (Gemini TTS's documented native rate).
function parsePcmRate(mimeType, fallback) {
  const m = /rate=(\d+)/.exec(mimeType ?? "");
  return m ? Number(m[1]) : fallback;
}

// `deps` is injectable for tests, matching synthesizeHeygen. Never throws;
// failures return { ok:false, words:null, error } naming WHY.
export async function synthesizeGemini({ text, voiceId, lang, wavAbs }, deps = {}) {
  const apiKey = deps.apiKey ?? geminiApiKey();
  const fetchImpl = deps.fetch ?? fetch;
  const transcode = deps.transcodeToWav ?? transcodeToWav;
  if (!apiKey) {
    return {
      ok: false,
      words: null,
      error: "no Gemini API key ($GEMINI_API_KEY / $GOOGLE_API_KEY)",
    };
  }
  try {
    const speechConfig = { voice: voiceId };
    if (lang && lang !== "en") speechConfig.language = lang;
    const body = {
      model: GEMINI_TTS_MODEL,
      input: text,
      response_modalities: ["audio"],
      generation_config: { speech_config: speechConfig },
    };
    const res = await fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text?.().catch(() => "");
      return {
        ok: false,
        words: null,
        error: `Gemini interactions POST → HTTP ${res.status}${detail ? `\n${String(detail).slice(0, 300)}` : ""}`,
      };
    }
    const payload = await res.json();
    const outAudio = payload?.output_audio;
    if (!outAudio?.data) {
      return {
        ok: false,
        words: null,
        error: "Gemini interactions response had no output_audio.data",
      };
    }
    const raw = Buffer.from(outAudio.data, "base64");
    const mimeType = outAudio.mime_type ?? "";
    // Already-boxed formats (wav/mp3/ogg) ffmpeg can sniff directly; a raw PCM
    // codec (audio/L16, audio/pcm) needs a WAV header wrapped on first so ffmpeg
    // has something to demux.
    const isRawPcm = /\bL16\b|\bpcm\b/i.test(mimeType) && !/\bwav\b/i.test(mimeType);
    const bytes = isRawPcm
      ? pcm16ToWav(
          raw,
          parsePcmRate(mimeType, outAudio.sample_rate ?? 24000),
          outAudio.channels ?? 1,
        )
      : raw;
    if (!transcode(bytes, wavAbs)) {
      return { ok: false, words: null, error: "wav transcode failed (ffmpeg)" };
    }
    return { ok: true, words: null };
  } catch (e) {
    return { ok: false, words: null, error: e?.message ? String(e.message) : String(e) };
  }
}

// ElevenLabs/Kokoro have no word timings — run Whisper over the wav. Returns the
// flat [{id,text,start,end}] word array, or null. Each call uses a throwaway
// --dir so parallel scenes don't collide on transcript.json.
export async function transcribeWav({ wavRel, lang = "en", kenectaiDir }) {
  const model = lang === "en" ? "small.en" : "small";
  const td = mkdtempSync(join(tmpdir(), "hf-trans-"));
  const args = ["kenectai", "transcribe", wavRel, "--model", model, "--dir", td];
  if (lang !== "en") args.push("--language", lang);
  const r = await spawnP("npx", args, { cwd: kenectaiDir });
  let words = null;
  if (r.status === 0) {
    const src = join(td, "transcript.json");
    if (existsSync(src)) {
      try {
        const arr = JSON.parse(readFileSync(src, "utf8"));
        if (Array.isArray(arr) && arr.length) words = arr;
      } catch {}
    }
  }
  rmSync(td, { recursive: true, force: true });
  return words;
}

// ── tiny local utils ──────────────────────────────────────────────────────────
function writeTmpText(text) {
  const td = mkdtempSync(join(tmpdir(), "hf-txt-"));
  const p = join(td, "line.txt");
  writeFileSync(p, text);
  return p;
}
function relTo(base, abs) {
  return abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
}
