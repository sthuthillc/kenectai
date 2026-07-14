#!/usr/bin/env python3
"""Generate BGM using Google Lyria 3 (batch music generation).

Usage:
    python lyria-recipe.py --output <path> --duration <seconds> [tuning flags]

Requires:
    $GOOGLE_API_KEY or $GEMINI_API_KEY environment variable (treated as aliases).
    `ffmpeg` on PATH (already a hard dependency of this whole audio pipeline —
    see tts.mjs's transcodeToWav). No pip packages: this calls the Interactions
    API directly over stdlib urllib, so there is nothing for bgm.mjs to
    pip-install-on-demand before running it (unlike the old google-genai
    live-session client this replaced).

API shape: lyria-3-pro-preview is a batch model reached through the Interactions
API (POST .../v1beta/interactions), not the old lyria-realtime-exp bidi-streaming
Music API (client.aio.live.music.connect()). It has no structured bpm/scale/
density/brightness config fields — those are folded into the natural-language
prompt instead (build_prompt below) and the model is asked for one clip, which
ffmpeg then loops or trims to the exact requested duration.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import wave
from pathlib import Path

API_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
MODEL = "lyria-3-pro-preview"
DEFAULT_PROMPT = "Uplifting corporate tech, bright and modern, gentle piano with synth pads"
SAMPLE_RATE = 48000
CHANNELS = 2
REQUEST_TIMEOUT_S = 180


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate BGM via Google Lyria 3 (batch).")
    p.add_argument("--output", required=True, help="Output WAV path.")
    p.add_argument("--duration", type=float, required=True, help="Target duration in seconds.")
    p.add_argument("--prompt", default=DEFAULT_PROMPT, help="Mood / instrumentation prompt.")
    p.add_argument("--negative-prompt", default=None, help="Styles to exclude (optional).")
    p.add_argument("--bpm", type=int, default=110)
    p.add_argument("--brightness", type=float, default=0.8, help="0-1, higher = brighter mood.")
    p.add_argument("--density", type=float, default=0.5, help="0-1, higher = fuller mix.")
    p.add_argument(
        "--scale",
        default="MAJOR",
        help="MAJOR / MINOR / PENTATONIC / etc., folded into the prompt as text. Pass empty string for none.",
    )
    return p.parse_args()


# Lyria 3's batch endpoint takes a single text prompt, not the live API's
# structured {bpm, brightness, density, scale} config — so the tuning knobs
# are described in natural language instead of set as fields.
def build_prompt(args: argparse.Namespace) -> str:
    parts = [args.prompt, f"BPM {args.bpm}"]
    if args.scale:
        parts.append(f"{args.scale.lower()} scale")
    if args.brightness is not None:
        tone = "bright" if args.brightness >= 0.7 else "dark" if args.brightness <= 0.3 else "warm"
        parts.append(f"{tone} tone")
    if args.density is not None:
        mix = (
            "full, layered mix"
            if args.density >= 0.7
            else "sparse, minimal mix"
            if args.density <= 0.3
            else "moderate mix density"
        )
        parts.append(mix)
    prompt = ", ".join(parts)
    if args.negative_prompt:
        prompt += f". Avoid: {args.negative_prompt}"
    return prompt


def call_lyria(prompt: str, api_key: str) -> dict:
    body = json.dumps(
        {
            "model": MODEL,
            "input": prompt,
            "response_format": {"type": "audio"},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=body,
        method="POST",
        headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"Lyria interactions POST -> HTTP {exc.code}\n{detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Lyria interactions POST failed: {exc.reason}") from exc


def audio_extension(mime_type: str) -> str:
    if "wav" in mime_type:
        return ".wav"
    if "mp3" in mime_type or "mpeg" in mime_type:
        return ".mp3"
    return ".bin"


def generate_bgm(args: argparse.Namespace) -> dict:
    api_key = os.environ.get("GOOGLE_API_KEY") or os.environ.get("GEMINI_API_KEY") or ""
    if not api_key:
        raise RuntimeError("Neither GOOGLE_API_KEY nor GEMINI_API_KEY is set.")

    payload = call_lyria(build_prompt(args), api_key)
    out_audio = payload.get("output_audio") or {}
    data_b64 = out_audio.get("data")
    if not data_b64:
        raise RuntimeError(
            f"Lyria interactions response had no output_audio.data (top-level keys: {list(payload.keys())})"
        )
    raw = base64.b64decode(data_b64)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        src_path = Path(td) / f"lyria-src{audio_extension(out_audio.get('mime_type', ''))}"
        src_path.write_bytes(raw)

        # -stream_loop -1 loops the (model-length) clip indefinitely; -t then
        # caps output at the target duration regardless of whether the source
        # clip came back longer or shorter than requested — one ffmpeg call
        # handles both the trim and the loop-to-length case.
        cmd = [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-stream_loop",
            "-1",
            "-i",
            str(src_path),
            "-t",
            f"{args.duration:.3f}",
            "-ar",
            str(SAMPLE_RATE),
            "-ac",
            str(CHANNELS),
            "-sample_fmt",
            "s16",
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0 or not out_path.exists():
            raise RuntimeError(f"ffmpeg failed converting Lyria output: {result.stderr[-500:]}")

    with wave.open(str(out_path), "rb") as wf:
        actual_duration = wf.getnframes() / float(wf.getframerate())

    print(f"BGM: {out_path} ({actual_duration:.2f}s)")
    return {"file": str(out_path), "duration_sec": round(actual_duration, 2)}


def main() -> None:
    args = parse_args()
    try:
        generate_bgm(args)
    except RuntimeError as exc:
        print(f"BGM generation failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
