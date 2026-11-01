// Root ESLint flat config — the single lint setup for the whole monorepo
// (apps/* and packages/*). Run it from the repo root via `npm run lint`.
//
// Layout:
//   1. Global ignores (build output + auto-generated code).
//   2. JS + typescript-eslint *recommended* rules for every TS/JS file.
//   3. A web-only block that layers React-Hooks + Tailwind rules on apps/web
//      (eslint-plugin-better-tailwindcss, built on Tailwind v4's own engine).
//   4. eslint-config-prettier LAST, so Prettier owns all formatting and ESLint
//      stops reporting stylistic rules that would fight the formatter.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import prettier from "eslint-config-prettier";
import globals from "globals";
import fs from "node:fs";
import path from "node:path";

// Tailwind 4.3's canonicalizer stops at `text-(--success)`, but when the theme
// aliases `--color-success: var(--success)` IntelliSense suggests the shorter
// `text-success`. Build an autofixable restriction for exactly those aliases,
// read from the CSS entry so new theme colors are picked up automatically.
const COLOR_UTILITIES =
  "text|bg|border(?:-[xytrblse])?|divide|outline|ring|ring-offset|inset-ring" +
  "|shadow|inset-shadow|fill|stroke|from|via|to|decoration|accent|caret|placeholder";
function themeColorShorthands(cssPath) {
  const css = fs.readFileSync(cssPath, "utf8");
  const names = [...css.matchAll(/--color-([\w-]+):\s*var\(--\1\)/g)].map((m) => m[1]);
  if (names.length === 0) return [];
  return [
    {
      pattern: `^(.*?)(${COLOR_UTILITIES})-\\(--(${names.join("|")})\\)([/!].*)?$`,
      fix: "$1$2-$3$4",
      message: 'Use the theme color: "$1$2-$3$4".',
    },
  ];
}
const webCss = path.join(import.meta.dirname, "apps/web/src/styles.css");

export default tseslint.config(
  // ── 1. Never lint build output or generated code ───────────────────────────
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dev-dist/**",
      "**/build/**",
      "**/.vite/**",
      "**/coverage/**",
      // Auto-generated from the OpenAPI spec — do not hand-edit, do not lint.
      "apps/web/src/api/**",
      "apps/web/src/api-types.ts",
      "apps/web/openapi.json",
    ],
  },

  // ── 2. Base rules for the entire monorepo ──────────────────────────────────
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      // Merge Node + browser globals so neither server code (process, Buffer)
      // nor browser code (window, document) trips `no-undef`.
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Underscore-prefixed args/vars are an intentional "unused" marker.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // ── 3. Web app: React Hooks correctness + Tailwind class hygiene ───────────
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: {
      "better-tailwindcss": betterTailwindcss,
      "react-hooks": reactHooks,
    },
    settings: {
      // Tailwind v4 keeps its config in CSS; point the plugin at the entry.
      // Relative paths resolve from ESLint's cwd, which differs between root
      // and workspace scripts — so anchor it absolutely. `cn`, `cva`, `clsx`,
      // `cx`, `twMerge` and `twJoin` are linted by default.
      "better-tailwindcss": {
        entryPoint: webCss,
        // Lets canonicalization turn px values into the spacing scale
        // (`w-[244px]` -> `w-61`). The app keeps the browser's 16px root.
        rootFontSize: 16,
      },
    },
    rules: {
      // React Hooks — real correctness bugs.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Tailwind: the plugin's recommended set (class order, canonical and
      // deprecated classes, duplicates, conflicts, whitespace), as warnings.
      // Everything except conflicts is autofixable.
      ...betterTailwindcss.configs["recommended-warn"].rules,
      // Off: line wrapping is Prettier's job.
      "better-tailwindcss/enforce-consistent-line-wrapping": "off",
      // Off: the app defines many plain CSS classes that aren't utilities.
      "better-tailwindcss/no-unknown-classes": "off",
      "better-tailwindcss/no-restricted-classes": [
        "warn",
        { restrict: themeColorShorthands(webCss) },
      ],
    },
  },

  // ── 4. Disable formatting rules that conflict with Prettier (keep last) ────
  prettier,
);
