<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/dark.svg">
    <img alt="KENECT AI" src="docs/logo/light.svg" width="320">
  </picture>
</p>

<h3 align="center">The video renderer your AI agent already knows how to use.</h3>

<p align="center">
  If it can be written as HTML, it can be rendered as video — deterministically,<br>
  locally or on KENECT AI's Google Cloud backend.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kenectai/cli"><img src="https://img.shields.io/npm/v/%40kenectai%2Fcli.svg?style=flat" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js"></a>
  <a href="https://docs.kenectai.com/introduction"><img src="https://img.shields.io/badge/docs-kenectai.com-0a0a0a" alt="Docs"></a>
</p>

---

## Why this exists

Video tooling assumes a human at a timeline. KENECT AI assumes an **agent at a keyboard**:

- **The source of truth is an `index.html` file.** No project format, no bundler, no React requirement. Anything that can write HTML — a person, Claude Code, Cursor, a CI job — can author a video.
- **Every frame is reproducible.** The renderer seeks headless Chrome frame-by-frame and encodes with FFmpeg. Same input, same bytes out. That makes video safe for CI, regression tests, and automated pipelines.
- **The knowledge ships with the tool.** Twenty agent skills encode the production patterns — pacing, motion language, captions, audio — that generic web knowledge misses.

## Two ways in

### 1 · Point an agent at it

```bash
npx skills add sthuthillc/kenectai --full-depth --yes
```

Then ask for what you want in plain language:

> Using `/hyperframes`, make a 15-second launch teaser for my landing page — bold typography, background music, end on the logo.

The `/hyperframes` router reads intent and hands off to the right workflow: product promos, website tours, topic explainers, PR walkthroughs, caption/overlay passes on real footage, beat-synced music videos, slide decks, or freeform motion graphics.

### 2 · Drive the CLI yourself

```bash
npx @kenectai/cli init my-video && cd my-video
npx @kenectai/cli preview     # live-reload preview in the browser
npx @kenectai/cli check       # headless-Chrome quality gate
npx @kenectai/cli render      # deterministic MP4 out
```

Requires Node.js 22+ and FFmpeg. No account needed for local rendering.

## Anatomy of a composition

One HTML file. Timing lives in `data-*` attributes; animation lives in any seekable runtime (GSAP, CSS, Lottie, Three.js, Anime.js, WAAPI); media playback is owned by the framework so seeking stays frame-accurate.

```html
<div id="stage" data-composition-id="teaser" data-start="0" data-width="1920" data-height="1080">
  <video class="clip" data-start="0" data-duration="6" data-track-index="0" src="bg.mp4" muted playsinline></video>
  <h1 id="headline" class="clip" data-start="1" data-duration="4" data-track-index="1">Ship it.</h1>
  <audio data-start="0" data-duration="6" data-track-index="2" data-volume="0.5" src="music.wav"></audio>

  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#headline", { opacity: 0, y: 40, duration: 0.8 }, 1);
    window.__timelines = window.__timelines || {};
    window.__timelines.teaser = tl;
  </script>
</div>
```

Declared variables (`data-composition-variables`) turn any composition into a template: upload once, re-render many times with different data.

## Rendering surfaces

| Surface | Command | When |
| --- | --- | --- |
| **Local** | `kenectai render` | Authoring loop; free; needs Chrome + FFmpeg |
| **KENECT AI Cloud (GCP)** | `kenectai cloud render` | Zero-infra hosted rendering on Cloud Run + Workflows; sign in with `kenectai auth login` (OAuth 2.0 + PKCE) or `KENECT_API_KEY` |
| **Your own AWS** | `kenectai lambda deploy / render` | Bring-your-own-cloud distributed rendering at batch scale |

The cloud path is upload → render → signed download URL, with `--no-wait` and webhook callbacks for fire-and-forget pipelines.

## Building blocks

- **Catalog** — 50+ installable blocks and components (shader transitions, kinetic captions, charts, maps, device mockups, social overlays): `npx @kenectai/cli add data-chart`. Browse at [docs.kenectai.com/catalog](https://docs.kenectai.com/catalog/blocks/data-chart).
- **Media engine** — one shared engine for TTS voiceover, background music, SFX, transcription, captions, and background removal, exposed to agents through the `/media-use` skill.
- **frame.md** — invert a web design system for the camera: same tokens, rewritten for scale, so an agent can compose on-brand video without guessing. See the [Claude Design guide](https://docs.kenectai.com/guides/claude-design).
- **Studio** — a browser editor for previewing and adjusting compositions (`kenectai preview` serves it).

## The skills, at a glance

<details>
<summary><b>Creation workflows</b> — routed automatically by <code>/hyperframes</code></summary>

| Skill | Turns … into video |
| --- | --- |
| `/product-launch-video` | A product URL, script, or brief → launch promo |
| `/website-to-video` | Any website → site tour / showcase |
| `/faceless-explainer` | Arbitrary text → topic explainer with invented visuals |
| `/pr-to-video` | A GitHub PR → code-change walkthrough |
| `/embedded-captions` | Talking-head footage → captioned footage (36 visual identities) |
| `/talking-head-recut` | Talking-head footage → footage + designed graphic overlays |
| `/motion-graphics` | A stat, headline, or logo → short kinetic hit |
| `/music-to-video` | A music track → beat-synced lyric/slideshow/promo |
| `/slideshow` | An outline → navigable presentation deck |
| `/general-video` | Anything else → freeform composition |
| `/remotion-to-hyperframes` | An existing Remotion project → KENECT AI HTML |

</details>

<details>
<summary><b>Domain skills</b> — loaded on demand by the workflows</summary>

`/hyperframes-core` (the composition contract) · `/hyperframes-animation` (motion rules + 7 runtime adapters) · `/hyperframes-keyframes` (seek-safe keyframing) · `/hyperframes-creative` (design direction) · `/media-use` (audio/image/asset resolution) · `/hyperframes-cli` (dev loop) · `/hyperframes-registry` (catalog install/authoring) · `/figma` (Figma import)

</details>

## Repository map

```
packages/
  cli/                 → the kenectai CLI (@kenectai/cli)
  core/                → composition parser, linter, runtime, frame adapters
  engine/              → seekable page-to-video capture (Puppeteer + FFmpeg)
  producer/            → full render pipeline: capture, encode, audio mix
  kenect-api/          → GCP Cloud Run product API (OAuth, uploads, renders, publish)
  gcp-cloud-run/       → distributed render adapter for Cloud Run + Workflows
  aws-lambda/          → distributed render adapter for AWS Lambda
  player/ studio/ sdk/ → embeddable player, browser editor, programmatic SDK
registry/              → installable blocks, components, and starter examples
skills/                → the 20 agent skills
docs/                  → documentation source (docs.kenectai.com)
```

## Contributing & development

```bash
bun install && bun run build && bun run test
```

Regression-test media (~490 MB) lives in [Git LFS](https://git-lfs.com) — run `git lfs install` before cloning for development, or skip it with `GIT_LFS_SKIP_SMUDGE=1`. Lint with `bunx oxlint`, format with `bunx oxfmt`, and gate compositions with `npx @kenectai/cli check`. See [CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities via [SECURITY.md](SECURITY.md).

## Heritage & license

KENECT AI is an independent fork of [HyperFrames](https://github.com/heygen-com/hyperframes) by HeyGen, whose engine also powers projects at [tldraw](https://tldraw.com), [TanStack](https://tanstack.com), and others ([ADOPTERS.md](ADOPTERS.md)). We're grateful for that foundation. Both projects are **[Apache 2.0](LICENSE)** — no per-render fees, no commercial-use thresholds.
