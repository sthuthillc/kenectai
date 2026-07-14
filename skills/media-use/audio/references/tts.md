# Text To Speech

`npx @kenectai/cli tts` auto-detects a provider from env vars; explicit override via `--provider`.

> **Run the Preflight first — no credential is not a green light to silently use the local voice.** Before generating a voiceover, complete the sign-in **Preflight** (see `../SKILL.md` → Preflight): run `npx @kenectai/cli auth status`, recommend signing in, and **STOP for the user's choice** (sign in for HeyGen voices, or continue offline with local Kokoro). This applies to a one-off "generate a voiceover" request just as much as inside a full workflow.

## Provider chain

| Order | Provider          | Env trigger                                 | Voice IDs                                   | Word timestamps                           | Audio format              |
| ----- | ----------------- | ------------------------------------------- | ------------------------------------------- | ----------------------------------------- | -------------------------- |
| 1     | HeyGen (Starfish) | `$HEYGEN_API_KEY` / `~/.heygen/credentials` | UUIDs from `GET /v3/voices?engine=starfish` | **Yes** (`word_timestamps[]` in response) | mp3 → wav via ffmpeg |
| 2     | Gemini native TTS | `$GEMINI_API_KEY` / `$GOOGLE_API_KEY`       | Prebuilt voice names (`Kore`, `Puck`, …)    | No                                        | pcm/wav → wav via ffmpeg |
| 3     | ElevenLabs        | `$ELEVENLABS_API_KEY`                       | UUIDs from elevenlabs.io dashboard          | No                                        | mp3 → wav via ffmpeg |
| 4     | Kokoro-82M        | always (local fallback)                     | `am_michael`, `af_heart`, … (54 voices)     | No                                        | wav direct           |

```bash
# Auto-detect (HeyGen if key set, else Gemini, else ElevenLabs, else Kokoro)
npx @kenectai/cli tts "Welcome to KENECT AI" -o narration.wav

# Pin the provider explicitly
npx @kenectai/cli tts "Hello" --provider kokoro
npx @kenectai/cli tts "Hello" --provider heygen --voice <heygen-uuid>
npx @kenectai/cli tts "Hello" --provider gemini --voice Kore
npx @kenectai/cli tts "Hello" --provider elevenlabs --voice 21m00Tcm4TlvDq8ikWAM

# HeyGen path: capture word timestamps in one call (skips a Whisper pass)
npx @kenectai/cli tts "Hi there" --words narration.words.json
```

### Gemini native TTS (`scripts/lib/tts.mjs` → `synthesizeGemini`)

Direct REST against the Interactions API (`generativelanguage.googleapis.com/v1beta/interactions`, `model: gemini-3.1-flash-tts-preview`) — no SDK, no pip dependency. Auto-selected between HeyGen and ElevenLabs when `$GEMINI_API_KEY` or `$GOOGLE_API_KEY` is set and HeyGen isn't credentialed. Default voice is the fixed prebuilt `Kore` (deterministic; override with `--voice`, e.g. `Puck`, `Charon`, `Fenrir`, `Aoede`). The response's `output_audio` may come back as raw PCM (`audio/L16;codec=pcm;rate=24000`) or an already-boxed container (wav/mp3); either way it's transcoded to 44.1k mono via ffmpeg like the other cloud providers. No word timings — chain `transcribeWav()` (Whisper) for captions, same as ElevenLabs/Kokoro.

## Self-contained HeyGen (no CLI) — `scripts/heygen-tts.mjs`

The published `kenectai tts` CLI synthesizes locally with Kokoro only. When you
want HeyGen specifically — best quality **plus** word timestamps in one call — use
the skill's bundled script, which calls the HeyGen v3 REST API directly and needs
no CLI provider plumbing:

The script resolves a HeyGen credential the same way the CLI does — first source
wins: `$HEYGEN_API_KEY` → `$KENECT_API_KEY` → a project `.env` (auto-loaded,
walks up ≤5 dirs) → `~/.heygen/credentials` (shared with heygen-cli;
`$HEYGEN_CONFIG_DIR` overrides the dir). An OAuth login is sent as
`Authorization: Bearer`; an API key as `X-Api-Key`; both include
`X-HeyGen-Source: cli`. OAuth CLI users can consume the web-plan free allowance
(10 min/month) before paid usage; API keys follow normal API billing. If the
only credential is an expired OAuth token it stops with a hint to run
`npx @kenectai/cli auth refresh`.

```bash
# Only needed if you haven't run `npx @kenectai/cli auth login`:
export HEYGEN_API_KEY=...   # or put it in a project .env

# Synthesize + capture word timestamps in one call (skips a Whisper pass)
node skills/media-use/audio/scripts/heygen-tts.mjs \
  "Welcome to KENECT AI." -o narration.wav --words narration.words.json

node skills/media-use/audio/scripts/heygen-tts.mjs ./script.txt -o narration.wav
node skills/media-use/audio/scripts/heygen-tts.mjs --list   # public starfish voices
```

- **Voice:** `--voice <id>` must be a **starfish** voice_id (`--list`, or `GET /v3/voices?engine=starfish`). v2-catalog ids are rejected with HTTP 400. Omit `--voice` (English) and it defaults to **Marcia** (`05f19352e8f74b0392a8f411eba40de1`, a fixed default so the choice is deterministic). Non-English with no `--voice` falls back to the first matching catalog voice.
- **Output:** `.wav` → transcoded to 44.1k mono via ffmpeg; `.mp3` → raw bytes (no ffmpeg needed).
- **Words:** `--words <path>` writes the flat `[{id,text,start,end}]` shape below, drop-in for the captions pipeline. HeyGen's `<start>`/`<end>` boundary sentinels are filtered out and ids are re-contiguous.
- **Non-English:** `--lang <code>` (anything but `en`) is sent as the request `language`.

## When to use which provider

| Goal                                                      | Use                                                 |
| --------------------------------------------------------- | --------------------------------------------------- |
| Best voice quality + word timestamps in one call          | **HeyGen**                                          |
| First-party Google infra, no third-party vendor           | **Gemini native TTS**                               |
| Drop-in cloud TTS, big voice catalog                      | **ElevenLabs**                                      |
| Offline, no API key, fast iteration                       | **Kokoro**                                          |
| Non-English multilingual with deterministic phonemization | **Kokoro** (`ef_dora`, `jf_alpha`, `zf_xiaobei`, …) |

## ffmpeg requirement

HeyGen + Gemini + ElevenLabs return mp3/pcm. The CLI transcodes to wav when `--output` ends in `.wav` (the default and what downstream `ffprobe` + Whisper expect). If you'd rather skip the transcode, pass `-o file.mp3`. Without `ffmpeg` on PATH, `.wav` output from the cloud providers fails — install ffmpeg or use `.mp3`.

## Voice selection (Kokoro)

Default `af_heart`. Curated picks:

| Content type      | Voice                  |
| ----------------- | ---------------------- |
| Product demo      | `af_heart`, `af_nova`  |
| Tutorial / how-to | `am_adam`, `bf_emma`   |
| Marketing / promo | `af_sky`, `am_michael` |
| Documentation     | `bf_emma`, `bm_george` |
| Casual / social   | `af_heart`, `af_sky`   |

Run `npx @kenectai/cli tts --list` for the bundled set.

## Multilingual (Kokoro voice prefix → language)

The first letter of a Kokoro voice ID picks the phonemizer language; `--lang` overrides auto-detection.

| Prefix | Language             |
| ------ | -------------------- |
| `a`    | American English     |
| `b`    | British English      |
| `e`    | Spanish              |
| `f`    | French               |
| `h`    | Hindi                |
| `i`    | Italian              |
| `j`    | Japanese             |
| `p`    | Brazilian Portuguese |
| `z`    | Mandarin             |

```bash
npx @kenectai/cli tts "La reunión empieza a las nueve" --voice ef_dora --provider kokoro
npx @kenectai/cli tts "Today is a nice day" --voice af_heart --provider kokoro
```

Valid `--lang` codes (only needed to override the voice's auto-detected language): `en-us`, `en-gb`, `es`, `fr-fr`, `hi`, `it`, `pt-br`, `ja`, `zh`.

Non-English phonemization requires `espeak-ng` system-wide (`brew install espeak-ng` / `apt-get install espeak-ng`).

## Speed

- `0.7-0.8` — tutorial, complex content, accessibility
- `1.0` — natural pace (default)
- `1.1-1.2` — intros, transitions, upbeat content
- `1.5+` — rarely appropriate, test carefully

Honored by Kokoro + HeyGen; ElevenLabs ignores `--speed` (use voice settings on their dashboard).

## Long scripts

Past a few paragraphs, write the text to a `.txt` file and pass the path. Inputs over ~5 minutes of speech may benefit from splitting into segments.

## HeyGen word-timestamp shape

When `--words <path>` is passed to a HeyGen call, the file is written in the same flat shape `transcribe` produces — drop-in compatible with the captions pipeline:

```json
[
  { "id": "w0", "text": "Hi", "start": 0.0, "end": 0.21 },
  { "id": "w1", "text": "there", "start": 0.22, "end": 0.55 }
]
```

For ElevenLabs / Kokoro, run `npx @kenectai/cli transcribe narration.wav --model small.en` to get the same shape.
