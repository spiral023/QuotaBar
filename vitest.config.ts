import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    pool: "vmForks",
    // Nur die TypeScript-Quelltests laden. Verhindert, dass versehentlich
    // kompilierte .test.js-Duplikate (CommonJS) neben den .test.ts mitgeladen
    // werden und die Pipeline rot färben.
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.worktrees/**",
      "**/.claude/**",
    ],
  },
});
