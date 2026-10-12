import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";

import { SHOTS } from "../src/reel/shots";

/** Storyboard: one keyframe per shot from the Reel composition (60 fps), named shot-<id>.png. */
const BROWSER = process.env.REMOTION_BROWSER || undefined;
const out = resolve(process.argv[2] ?? "out/storyboard");
const only = process.argv[3]?.split(",");
mkdirSync(out, { recursive: true });
const root = resolve(import.meta.dirname, "..");
const serveUrl = await bundle({ entryPoint: join(root, "src/index.ts"), publicDir: join(root, "public") });
const inputProps = { fps: 60 };
const composition = await selectComposition({ serveUrl, id: "Reel", inputProps, browserExecutable: BROWSER });
const jobs: [string, number][] = SHOTS.filter((s) => !only || only.includes(s.id)).map((s) => [`shot-${s.id}`, s.start + s.key]);
if (!only || only.includes("8b")) jobs.push(["shot-8b-1", 27.2], ["shot-8b-2", 27.5], ["shot-8b-3", 27.85]);
for (const [name, time] of jobs) {
  const output = join(out, `${name}.png`);
  await renderStill({ serveUrl, composition, inputProps, frame: Math.round(time * 60), output, overwrite: true, browserExecutable: BROWSER });
  console.log(output);
}
