import { defineConfig } from "vite";

// Relative base so the built site works whether served from a domain root
// (Cloudflare Pages) or a project subpath (GitHub Pages /repo/).
export default defineConfig({
  base: "./",
  build: { target: "es2022" },
});
