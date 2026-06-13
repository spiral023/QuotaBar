import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "release/**",
      "package-output/**",
      "assets/vendor/**",
      "coverage/**",
      ".vitest/**",
      ".worktrees/**",
      ".claude/**",
      ".superpowers/**",
      "tests/**/*.test.js",
    ],
  },
  {
    files: ["src/renderer/**/*.js", "tests/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.commonjs,
        ...globals.node,
        QB: "writable",
        Chart: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-redeclare": "off",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "none",
          varsIgnorePattern: "^(QB|Chart|require|_)",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-useless-assignment": "off",
    },
  },
);
