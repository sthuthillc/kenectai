import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built assets live under /app/ in the kenect-web container so they never
// collide with the hand-authored landing page at /. Page routes themselves
// (/pricing, /dashboard, …) are top-level — nginx rewrites them to
// /app/index.html and React Router takes over.
export default defineConfig(({ command }) => ({
  // Production assets live under /app/ (see Dockerfile.kenect-web); dev
  // serves at / so routes match without the prefix.
  base: command === "build" ? "/app/" : "/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Mirrors the production nginx proxy so dev works against the live API.
      "/v1": { target: "https://api.kenectai.com", changeOrigin: true },
      "/v3": { target: "https://api.kenectai.com", changeOrigin: true },
      "/oauth": { target: "https://api.kenectai.com", changeOrigin: true },
      "/mcp": { target: "https://api.kenectai.com", changeOrigin: true },
    },
  },
}));
