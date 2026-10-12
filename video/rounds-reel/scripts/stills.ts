import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

/**
 * From product-film scripts/stills.ts: bundle once, render many stills. Frames are given in SECONDS here
 * (t=3.6), so every direction is compared at the same moment whatever the fps.
 *   bun scripts/stills.ts <out dir> <seconds>... --composition A,B,C [--debug]
 */
const BROWSER = process.env.REMOTION_BROWSER || undefined;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const comps = (flag("--composition") ?? "").split(",").filter(Boolean);
const debug = args.includes("--debug");
const [dir, ...times] = args.filter((a) => a !== "--debug");
const root = resolve(import.meta.dirname, "..");
const out = resolve(dir);
mkdirSync(out, { recursive: true });
const started = Date.now();
const serveUrl = await bundle({ entryPoint: join(root, "src/index.ts"), publicDir: join(root, "public") });
console.log(`bundled in ${((Date.now() - started) / 1000).toFixed(1)} s`);
const inputProps = { fps: 30, debug };
for (const id of comps) {
  const composition = await selectComposition({ serveUrl, id, inputProps, browserExecutable: BROWSER });
  for (const s of times) {
    const frame = Math.round(Number(s) * 30);
    const output = join(out, `${id}-t${s}.png`);
    const t0 = Date.now();
    await renderStill({ serveUrl, composition, inputProps, frame, output, overwrite: true, browserExecutable: BROWSER, chromiumOptions: { gl: "swangle" } });
    console.log(output, `${Date.now() - t0} ms`);
  }
}
