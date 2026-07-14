# Requirements & Caches

## Credential & key priority

Run `npx @kenectai/cli auth status` to see what's configured and which engines a workflow will use (see the skill's **Preflight** section). Keys resolve in this order — **first match wins**:

| Provider                             | Resolution order (first non-empty wins)                                                                                                                                    | Local deps when used                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **HeyGen** (TTS + BGM/SFX retrieval) | `$HEYGEN_API_KEY` → `$KENECT_API_KEY` → `~/.heygen/credentials` (shared with heygen-cli; `$HEYGEN_CONFIG_DIR` overrides the dir; written by `kenectai auth login`) | none (REST)                                      |
| **Gemini native TTS** (TTS fallback) | `$GEMINI_API_KEY` → `$GOOGLE_API_KEY`                                                                                                                                      | none (REST)                                      |
| **ElevenLabs** (TTS fallback)        | `$ELEVENLABS_API_KEY`                                                                                                                                                      | `pip install elevenlabs`                         |
| **Lyria** (BGM fallback)             | `$GEMINI_API_KEY` → `$GOOGLE_API_KEY`                                                                                                                                      | none (REST)                                      |
| **Kokoro** (TTS, no key)             | always — final voice fallback                                                                                                                                              | `pip install kokoro-onnx soundfile`              |
| **MusicGen** (BGM, no key)           | always — final music fallback                                                                                                                                              | `pip install transformers torch soundfile numpy` |

`kenectai auth login` (browser OAuth) is the recommended setup: one sign-in, every project, no per-repo `.env`. An OAuth login is sent as `Authorization: Bearer`; an API key as `X-Api-Key`; both are tagged with `X-HeyGen-Source: cli`. OAuth CLI users can consume the web-plan free allowance for HeyGen TTS (10 min/month); API keys follow the normal API billing path. With no HeyGen credential, voice/BGM run fully locally (Kokoro / MusicGen) — `kenectai auth status` and `kenectai doctor` both report whether those local deps are installed.

## Model caches & system dependencies

Each command downloads its own model on first run and caches it under `~/.cache/kenectai/`:

- **TTS (HeyGen)** — no local deps; needs a HeyGen credential + `ffmpeg` on PATH (to transcode the mp3 response to `.wav`). Credential resolves like the CLI: `$HEYGEN_API_KEY` → `$KENECT_API_KEY` → `~/.heygen/credentials` (shared with heygen-cli; run `npx @kenectai/cli auth login`). An OAuth login is sent as `Authorization: Bearer`; an API key as `X-Api-Key`; both include `X-HeyGen-Source: cli` so the backend can apply CLI OAuth free usage.
- **TTS (ElevenLabs)** — same as HeyGen: API key + `ffmpeg`.
- **TTS (Kokoro)** — Kokoro-82M (~311 MB) + voices (~27 MB) in `tts/`. Requires Python 3.8+ with `kokoro-onnx` and `soundfile` (`pip install kokoro-onnx soundfile`). Non-English text also needs `espeak-ng` system-wide.
- **TTS (Gemini native)** — no local deps; needs `$GEMINI_API_KEY`/`$GOOGLE_API_KEY` + `ffmpeg` on PATH (to transcode the response to `.wav`). Direct REST against the Interactions API — no SDK.
- **BGM (Lyria)** — needs `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` + `ffmpeg` on PATH. Direct REST against the Interactions API (`lyria-3-pro-preview`) — no SDK, no pip package. No local model cache.
- **BGM (MusicGen)** — `pip install transformers torch soundfile`. `facebook/musicgen-small` (~300 MB) cached under `~/.cache/huggingface/` on first run.
- **Transcribe** — Whisper model size depending on choice (75 MB – 3.1 GB) in `whisper/`. Bundles `whisper.cpp`.
- **Remove-background** — `u2net_human_seg` (~168 MB ONNX) in `background-removal/models/`. Peak inference RAM ~1.5 GB.

Run `npx @kenectai/cli doctor` if a command fails because of a missing dependency.
