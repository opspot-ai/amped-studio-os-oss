import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const apiTarget = process.env.ADMIN_API_PROXY ?? "http://127.0.0.1:3210";

export default defineConfig({
  build: { outDir: "dist" },
  resolve: {
    alias: {
      zod: fileURLToPath(new URL("./node_modules/zod/index.js", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        headers: { origin: apiTarget },
      },
    },
  },
  plugins: [react()],
});
