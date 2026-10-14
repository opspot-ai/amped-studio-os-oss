import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const apiTarget = process.env.STUDIO_API_PROXY ?? "http://127.0.0.1:3212";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  resolve: {
    alias: {
      zod: fileURLToPath(new URL("./node_modules/zod/index.js", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
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
