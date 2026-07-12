# doctor, browser

Environment diagnosis and bundled-Chrome management. Run these first when a render or preview fails.

## doctor

```bash
npx @kenectai/cli doctor
npx @kenectai/cli doctor --json     # CI / agent output (always exit 0; gate on payload `ok`)
```

Runs independent checks and reports each as ok/warn/fail:

- **Version** — installed CLI vs latest on npm (hints upgrade when stale)
- **Node.js** — ≥ 22 required
- **CPU**, **Memory**, **Disk** — host resources
- **Environment** — env vars that affect the renderer
- **FFmpeg** / **FFprobe** — found, version, codecs
- **Chrome** — bundled or system, version, path
- **Docker** / **Docker running** — required only for `render --docker`
- **/dev/shm** — inside containers only

Run `doctor` first when:

- `render` fails with a Chrome or FFmpeg error.
- `preview` opens but the composition fails to load.
- A fresh machine has never run HyperFrames.

Common issues:

- **Missing FFmpeg** — install via `brew install ffmpeg` (macOS) or your package manager.
- **Missing bundled Chrome** — run `npx @kenectai/cli browser ensure`.
- **Low memory** — close other Chromes, reduce `--workers`, or use `--quality draft`.

## browser

```bash
npx @kenectai/cli browser ensure    # find or download the pinned Chrome
npx @kenectai/cli browser path      # print the browser executable path (for scripting)
npx @kenectai/cli browser clear     # remove the cached Chrome download
```

Manage the Chrome build HyperFrames uses for rendering. The pinned version exists because pixel output drifts across Chrome versions — using the bundled build keeps rendered output reproducible across machines.

Use `path` to embed the binary in scripts: `$(npx @kenectai/cli browser path)`.
