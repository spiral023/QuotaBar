import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    pool: "vmForks",
    // Several portable-store tests spawn real processes or build large fixtures
    // and legitimately take 3-4.5s. Under the default 5s budget they passed in
    // isolation but failed sporadically when the suite ran them in parallel, so
    // the budget is raised to leave headroom rather than chase individual tests.
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
