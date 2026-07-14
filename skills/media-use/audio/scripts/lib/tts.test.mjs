import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFfmpegDurationBanner,
  ffprobeDuration,
  synthesizeOne,
  synthesizeHeygen,
  synthesizeGemini,
  synthResult,
  pickProvider,
  pcm16ToWav,
} from "./tts.mjs";

test("parseFfmpegDurationBanner reads ffmpeg's stderr Duration line", () => {
  const stderr = [
    "ffmpeg version 6.0",
    "Input #0, wav, from 'a.wav':",
    "  Duration: 00:00:03.42, bitrate: 705 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  assert.equal(parseFfmpegDurationBanner(stderr), 3.42);
});

test("parseFfmpegDurationBanner handles an hours component", () => {
  const stderr = "  Duration: 01:02:03.50, start: 0.000000, bitrate: 128 kb/s";
  assert.equal(parseFfmpegDurationBanner(stderr), 3723.5);
});

test("parseFfmpegDurationBanner returns NaN when there is no Duration line", () => {
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("ffmpeg: command not found")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner("")));
  assert.ok(Number.isNaN(parseFfmpegDurationBanner(undefined)));
});

// Regression for the actual bug: ffprobeDuration used to collapse "ffprobe
// binary is missing" (ENOENT — the "essentials"-style Windows ffmpeg build
// with no ffprobe.exe) and "file is genuinely unreadable" into the same NaN,
// giving audio.mjs no way to tell "measure differently" from "give up".
//
// Builds an isolated PATH containing only a fake `ffmpeg` stub (no `ffprobe`
// at all) so ffprobeDuration's spawnSync("ffprobe", ...) call ENOENTs for
// real, then verifies it recovers the duration via the ffmpeg fallback
// instead of returning NaN.
test("ffprobeDuration falls back to ffmpeg when the ffprobe binary itself is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-ffprobe-fallback-"));
  const fakeFfmpeg = join(dir, "ffmpeg");
  writeFileSync(
    fakeFfmpeg,
    "#!/bin/sh\necho 'Duration: 00:00:02.50, start: 0.000000, bitrate: 128 kb/s' 1>&2\nexit 1\n",
  );
  chmodSync(fakeFfmpeg, 0o755);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // only the fake ffmpeg resolves; no real ffprobe on this PATH
    assert.equal(ffprobeDuration("/does/not/matter.wav"), 2.5);
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffprobeDuration returns NaN when neither ffprobe nor ffmpeg resolve", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-no-binaries-"));
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir; // empty directory — nothing resolves
    assert.ok(Number.isNaN(ffprobeDuration("/does/not/matter.wav")));
  } finally {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeOne(elevenlabs) creates the output dir before writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-el-mkdir-"));
  const wavAbs = join(dir, "assets", "voice", "line-0.wav"); // nested, not yet created
  const savedKey = process.env.ELEVENLABS_API_KEY;
  try {
    // Unset the key so the Python side fails fast — the mkdir must run before
    // the spawn regardless, which is what this guards.
    delete process.env.ELEVENLABS_API_KEY;
    await synthesizeOne({
      provider: "elevenlabs",
      text: "hi",
      voiceId: "v",
      wavAbs,
      kenectaiDir: dir,
    });
    assert.ok(existsSync(dirname(wavAbs)), "output directory should be created");
  } finally {
    if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthesizeHeygen surfaces a thrown HTTP error (e.g. 402) instead of swallowing it", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => {
        throw new Error("HeyGen POST /voices/speech → HTTP 402\nplan_upgrade_required");
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /402/);
  assert.match(res.error, /plan_upgrade_required/);
});

test("synthesizeHeygen surfaces a failed audio_url fetch with its status", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    {
      heygenAuthHeaders: () => ({}),
      heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
      fetch: async () => ({ ok: false, status: 403 }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 403/);
});

test("synthesizeHeygen reports a missing audio_url", async () => {
  const res = await synthesizeHeygen(
    { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: "/tmp/x.wav" },
    { heygenAuthHeaders: () => ({}), heygenJSON: async () => ({}) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no audio_url/);
});

test("synthesizeHeygen reports wav transcode failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-tts-test-"));
  try {
    const res = await synthesizeHeygen(
      { text: "hi", voiceId: "v1", lang: "en", speed: 1, wavAbs: join(dir, "voice.wav") },
      {
        heygenAuthHeaders: () => ({}),
        heygenJSON: async () => ({ data: { audio_url: "http://audio.example/x" } }),
        fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
        transcodeToWav: () => false,
      },
    );
    assert.equal(res.ok, false);
    assert.equal(res.error, "wav transcode failed (ffmpeg)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synthResult names a non-zero subprocess exit", () => {
  const res = synthResult({ status: 2 }, "/tmp/none.wav", "kokoro (npx @kenectai/cli tts)");
  assert.equal(res.ok, false);
  assert.match(res.error, /kokoro .* exited with status 2/);
});

test("synthesizeGemini reports a missing API key without touching the network", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    { apiKey: "", fetch: () => assert.fail("must not fetch without a key") },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no Gemini API key/);
});

test("synthesizeGemini surfaces a non-OK interactions response with its status", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    {
      apiKey: "k",
      fetch: async () => ({ ok: false, status: 429, text: async () => "rate_limited" }),
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 429/);
  assert.match(res.error, /rate_limited/);
});

test("synthesizeGemini reports a response with no output_audio.data", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    { apiKey: "k", fetch: async () => ({ ok: true, json: async () => ({}) }) },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /no output_audio\.data/);
});

test("synthesizeGemini wraps raw PCM output in a WAV header before transcoding", async () => {
  const pcmBase64 = Buffer.from([1, 2, 3, 4]).toString("base64");
  let transcodedBytes = null;
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    {
      apiKey: "k",
      fetch: async () => ({
        ok: true,
        json: async () => ({
          output_audio: {
            data: pcmBase64,
            mime_type: "audio/L16;codec=pcm;rate=24000",
            sample_rate: 24000,
            channels: 1,
          },
        }),
      }),
      transcodeToWav: (bytes) => {
        transcodedBytes = bytes;
        return true;
      },
    },
  );
  assert.equal(res.ok, true);
  // 44-byte WAV header + the 4 raw PCM bytes, not the 4 raw bytes alone.
  assert.equal(transcodedBytes.length, 48);
  assert.equal(transcodedBytes.subarray(0, 4).toString(), "RIFF");
});

test("synthesizeGemini passes an already-boxed wav response straight through untouched", async () => {
  const wavBytes = Buffer.from([9, 9, 9]);
  let transcodedBytes = null;
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    {
      apiKey: "k",
      fetch: async () => ({
        ok: true,
        json: async () => ({
          output_audio: { data: wavBytes.toString("base64"), mime_type: "audio/wav" },
        }),
      }),
      transcodeToWav: (bytes) => {
        transcodedBytes = bytes;
        return true;
      },
    },
  );
  assert.equal(res.ok, true);
  assert.deepEqual([...transcodedBytes], [9, 9, 9]);
});

test("synthesizeGemini reports a wav transcode failure", async () => {
  const res = await synthesizeGemini(
    { text: "hi", voiceId: "Kore", lang: "en", wavAbs: "/tmp/x.wav" },
    {
      apiKey: "k",
      fetch: async () => ({
        ok: true,
        json: async () => ({
          output_audio: { data: Buffer.from([1]).toString("base64"), mime_type: "audio/wav" },
        }),
      }),
      transcodeToWav: () => false,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, "wav transcode failed (ffmpeg)");
});

test("pcm16ToWav produces a valid 44-byte RIFF/WAVE header sized for the payload", () => {
  const pcm = Buffer.from(new Array(100).fill(0));
  const wav = pcm16ToWav(pcm, 24000, 1);
  assert.equal(wav.length, 144);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt32LE(40), 100); // data chunk size
});

test("pickProvider rejects an unknown explicit provider, naming gemini as valid", () => {
  assert.throws(() => pickProvider("bogus"), /heygen \| gemini \| elevenlabs \| kokoro/);
});

test("pickProvider honors an explicit gemini choice only when a key is present", () => {
  const saved = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    assert.throws(() => pickProvider("gemini"), /neither \$GEMINI_API_KEY nor \$GOOGLE_API_KEY/);
    process.env.GEMINI_API_KEY = "k";
    assert.equal(pickProvider("gemini"), "gemini");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
