import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

// Derive the project root from THIS FILE's location, NOT from process.cwd().
// Using `process.cwd()` breaks when `pnpm dev` is launched from anywhere
// other than mako-markets/ (e.g. from an IDE at the workspace root). When
// that happens, Turbopack pins to the parent directory, tries to resolve
// `tailwindcss` from there, fails, and OOMs during cache deserialization.
// `__dirname` is always the directory of this config file regardless of cwd.
const PROJECT_ROOT = __dirname;

const nextConfig: NextConfig = {
  turbopack: {
    root: PROJECT_ROOT,
  },
  // The design system site is a static page in public/designsystem/. Serve
  // it at /designsystem as well as /designsystem/index.html.
  async rewrites() {
    return [{ source: "/designsystem", destination: "/designsystem/index.html" }];
  },
};

// Sentry (src/lib/sentry-options.ts): reports go through Mako Market's own /monitoring route so ad blockers do not drop
// them (Joshua, 2026-10-06). Source maps upload only when SENTRY_AUTH_TOKEN is set (Vercel and Bitwarden, never the
// repo); org and project come from the environment too, so nothing here is account-specific.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  tunnelRoute: "/monitoring",
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  telemetry: false,
});
