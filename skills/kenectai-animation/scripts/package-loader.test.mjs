import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = "KENECT_SKILL_PKG_VERSION";

// (a) env override wins — no ancestor lookup, exact version echoed back.
test("kenectaiPackageSpec: env override wins", async () => {
  const prev = process.env[ENV];
  process.env[ENV] = "9.9.9";
  try {
    const { kenectaiPackageSpec } = await import("./package-loader.mjs");
    assert.equal(kenectaiPackageSpec("@kenectai/producer"), "@kenectai/producer@9.9.9");
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
});

// (b) resolvable version (in-repo) pins the bundled kenectai/@kenectai/cli version.
test("kenectaiPackageSpec: resolvable in-repo version pins it", async () => {
  const prev = process.env[ENV];
  delete process.env[ENV];
  try {
    const { kenectaiPackageSpec } = await import("./package-loader.mjs");
    const spec = kenectaiPackageSpec("@kenectai/producer");
    assert.match(spec, /^@kenectai\/producer@\d+\.\d+\.\d+/);
  } finally {
    if (prev !== undefined) process.env[ENV] = prev;
  }
});

// (c) unresolvable + no override -> @latest fallback, no throw (global-install case).
// Copy the loader into an isolated temp dir whose ancestor chain has no kenectai
// package.json, and run node from there so cwd cannot resolve one either.
test("kenectaiPackageSpec: unresolvable falls back to @latest without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-pkgloader-"));
  try {
    copyFileSync(join(HERE, "package-loader.mjs"), join(dir, "package-loader.mjs"));
    const probe = join(dir, "probe.mjs");
    writeFileSync(
      probe,
      [
        'import { kenectaiPackageSpec } from "./package-loader.mjs";',
        'process.stdout.write(kenectaiPackageSpec("@kenectai/producer"));',
        "",
      ].join("\n"),
    );
    const res = spawnSync(process.execPath, [probe], { cwd: dir, encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "@kenectai/producer@latest");
    assert.match(res.stderr, /using @latest/);
    assert.match(res.stderr, new RegExp(ENV));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
