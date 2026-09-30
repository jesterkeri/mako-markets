import type { NextConfig } from "next";

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

export default nextConfig;
