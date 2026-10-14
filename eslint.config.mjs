import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".claude/**",
      "**/.next/**",
      "**/dist/**",
      "apps/control/public/**",
      "e2e/**",
      "data/**",
      "backups/**",
      "ventures/schema/**",
      "apps/studio/scripts/**",
      "apps/studio/tests/**",
      "apps/studio/worker/**",
      "apps/studio/vite.config.mjs",
      "apps/admin/vite.config.mjs"
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly"
      }
    }
  }
);
