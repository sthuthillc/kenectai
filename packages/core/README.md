# @kenectai/core

Types, parsers, generators, compiler, linter, runtime, and frame adapters for the KENECT AI video framework.

## Install

```bash
npm install @kenectai/core
```

> Most users don't need to install core directly — the [CLI](../cli), [producer](../producer), and [studio](../studio) packages depend on it internally.

## What's inside

| Module             | Description                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| **Types**          | `TimelineElement`, `CompositionSpec`, `Asset`, canvas dimensions, defaults                           |
| **Parsers**        | `parseHtml` — extract timeline elements from HTML; `parseGsapScript` — parse GSAP animations         |
| **Generators**     | `generateHyperframesHtml` — produce valid KENECT AI HTML from a composition spec                   |
| **Compiler**       | `compileTimingAttrs` — resolve `data-start` / `data-duration` into absolute times                    |
| **Linter**         | `lintHyperframeHtml` — validate KENECT AI HTML (missing attributes, overlapping tracks, etc.)      |
| **Runtime**        | IIFE script injected into the browser — manages seek, media playback, and the `window.__hf` protocol |
| **Frame Adapters** | Pluggable animation drivers (GSAP, Lottie, CSS, or custom)                                           |

## Frame Adapters

A frame adapter tells the engine how to seek your animation to a specific frame:

```typescript
import { createGSAPFrameAdapter } from "@kenectai/core";

const adapter = createGSAPFrameAdapter({
  getTimeline: () => gsap.timeline(),
  compositionId: "my-video",
});
```

Implement `FrameAdapter` for custom animation runtimes:

```typescript
import type { FrameAdapter } from "@kenectai/core";

const myAdapter: FrameAdapter = {
  id: "my-adapter",
  getDurationFrames: () => 300,
  seekFrame: (frame) => {
    /* seek your animation */
  },
};
```

## Parsing and generating HTML

```typescript
import { parseHtml, generateHyperframesHtml } from "@kenectai/core";

const { elements, metadata } = parseHtml(htmlString);
const html = generateHyperframesHtml(spec);
```

## Linting

```typescript
import { lintHyperframeHtml } from "@kenectai/core/lint";

const result = lintHyperframeHtml(htmlString);
// result.findings: { severity, message, elementId }[]
```

## Documentation

Full documentation: [docs.kenectai.com/packages/core](https://docs.kenectai.com/packages/core)

## Related packages

- [`@kenectai/engine`](../engine) — rendering engine that drives the browser
- [`@kenectai/producer`](../producer) — full render pipeline (capture + encode)
- [`@kenectai/cli`](../cli) — CLI
