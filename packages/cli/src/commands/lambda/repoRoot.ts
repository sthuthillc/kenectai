/**
 * Resolve the KENECT AI repo root. Used by `lambda deploy`/`destroy`
 * to find `examples/aws-lambda/template.yaml` and the handler ZIP build
 * script.
 *
 * Walks up from this file's location until it finds a directory that
 * contains `packages/aws-lambda/`. Caching is unnecessary — this runs
 * once per CLI invocation.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(): string {
  const override = process.env.KENECT_REPO_ROOT;
  if (override && existsSync(resolve(override, "packages", "aws-lambda", "package.json"))) {
    return override;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(resolve(dir, "packages", "aws-lambda", "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "[kenectai lambda] could not find the repo root (no packages/aws-lambda/ above this CLI's source). " +
      "Run `kenectai lambda` from within a kenectai checkout, or set KENECT_REPO_ROOT explicitly.",
  );
}
