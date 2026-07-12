# @kenectai/cli

CLI for creating, previewing, and rendering HTML video compositions.

## Install

```bash
npm install -g @kenectai/cli
```

Or use directly with npx:

```bash
npx @kenectai/cli <command>
```

**Requirements:** Node.js >= 22, FFmpeg

## Commands

### `init`

Scaffold a new KENECT AI project from a template:

```bash
npx @kenectai/cli init my-video
cd my-video
```

### `preview`

Start the live preview studio in your browser:

```bash
npx @kenectai/cli preview
# Studio running at http://localhost:3002

npx @kenectai/cli preview --port 4567
```

### `render`

Render a composition to MP4. Run from the project directory; the positional
argument is the project directory (not a file), so render the project's
`index.html` directly, or point at a specific composition file with `-c`:

```bash
npx @kenectai/cli render -o output.mp4
npx @kenectai/cli render -c ./my-composition.html -o output.mp4
```

### `lint`

Validate your KENECT AI HTML:

```bash
npx @kenectai/cli lint ./my-composition
npx @kenectai/cli lint ./my-composition --json      # JSON output for CI/tooling
npx @kenectai/cli lint ./my-composition --verbose   # Include info-level findings
```

By default only errors and warnings are shown. Use `--verbose` to also display informational findings (e.g., external script dependency notices). Use `--json` for machine-readable output with `errorCount`, `warningCount`, `infoCount`, and a `findings` array.

### `compositions`

List compositions found in the current project:

```bash
npx @kenectai/cli compositions
```

### `benchmark`

Run rendering benchmarks:

```bash
npx @kenectai/cli benchmark ./my-composition.html
```

### `doctor`

Check your environment for required dependencies (Chrome, FFmpeg, Node.js):

```bash
npx @kenectai/cli doctor
```

### `browser`

Manage the bundled Chrome/Chromium installation:

```bash
npx @kenectai/cli browser
```

### `info`

Print version and environment info:

```bash
npx @kenectai/cli info
```

### `docs`

Open the documentation in your browser:

```bash
npx @kenectai/cli docs
```

### `upgrade`

Check for updates and show upgrade instructions:

```bash
npx @kenectai/cli upgrade
npx @kenectai/cli upgrade --check --json  # machine-readable for agents
```

## Documentation

Full documentation: [docs.kenectai.com/packages/cli](https://docs.kenectai.com/packages/cli)

## Related packages

- [`@kenectai/core`](../core) — types, parsers, frame adapters
- [`@kenectai/engine`](../engine) — rendering engine
- [`@kenectai/producer`](../producer) — render pipeline
- [`@kenectai/studio`](../studio) — composition editor UI
