import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/hyperframes-player.ts", "src/slideshow/hyperframes-slideshow.ts"],
  format: ["esm", "cjs", "iife"],
  globalName: "HyperframesPlayer",
  noExternal: ["@hyperframes/core"],
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
});
