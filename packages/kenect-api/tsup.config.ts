import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    server: "src/server.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  external: [
    "@google-cloud/storage",
    "@hono/node-server",
    "@hyperframes/gcp-cloud-run",
    "adm-zip",
    "hono",
  ],
});
