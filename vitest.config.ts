import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@amped-studio-os/contracts": `${root}packages/contracts/src/index.ts`,
      "@amped-studio-os/packs": `${root}packages/packs/src/index.ts`,
      "@amped-studio-os/policy": `${root}packages/policy/src/index.ts`,
      "@amped-studio-os/storage": `${root}packages/storage/src/index.ts`,
      "@amped-studio-os/dispatch": `${root}packages/dispatch/src/index.ts`,
      "@amped-studio-os/adapters": `${root}packages/adapters/src/index.ts`,
      "@amped-studio-os/domain": `${root}packages/domain/src/index.ts`
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "json-summary"] }
  }
});
