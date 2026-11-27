// ESLint flat config (GEN-233). `npm run lint` runs this after the typecheck, and the Guards workflow's Lint job
// runs `npm run lint`. ESLint's and typescript-eslint's recommended sets, as in cookoffchamps.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".wrangler/**", "deploy/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "prefer-const": ["error", { destructuring: "all" }],
      // The control-character regexes are deliberate: they strip or reject control bytes in headers, mail,
      // log lines and task text (mail/message.ts, emailAddress.ts, taskDisplay.ts and others).
      "no-control-regex": "off",
      // Lookalike characters in comments and template literals are the test data for the homograph and BOM checks.
      "no-irregular-whitespace": ["error", { skipComments: true, skipTemplates: true }],
      // Cloudflare's Env is extended by declaration merging (declare namespace Cloudflare { interface Env … }).
      "@typescript-eslint/no-namespace": ["error", { allowDeclarations: true }],
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "with-single-extends" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  // Test doubles and harnesses cast freely; production code stays any-free (0 at adoption, 2026-11-26).
  {
    files: ["**/test/**", "**/test-workers/**", "**/*.test.{ts,mjs}", "**/*.contract.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  { files: ["web/**/*.{ts,tsx,js}"], languageOptions: { globals: globals.browser } },
  { files: ["server/**/*.ts", "shared/**/*.ts", "scripts/**/*.{js,mjs,cjs}", "*.config.{ts,mjs}"], languageOptions: { globals: globals.node } },
);
