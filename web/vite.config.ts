import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built site works whether served from a domain root
// (Cloudflare Pages) or a project subpath (GitHub Pages /repo/).
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        characterize: resolve(__dirname, "characterize.html"),
      },
    },
  },
});
