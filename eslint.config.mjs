import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Gemini's staged reference components — not wired into the app yet.
    // Lint when integrated. See memory: "Isolate Gemini staged components".
    "staged-gemini/**",
    // Agent worktrees: a full second copy of the repo, which would otherwise
    // be linted twice and report duplicate findings.
    ".claude/worktrees/**",
    // Worker build output (gitignored; wrangler writes it locally).
    "watchdog/dist/**",
    "watchdog/.wrangler/**",
    "cf-worker/dist/**",
    "cf-worker/.wrangler/**",
  ]),
]);

export default eslintConfig;
