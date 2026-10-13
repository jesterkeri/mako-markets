# Mako Market ad (60 s)

A 60 s, 16:9 ad for makomarket.xyz: 38 shots at 120 BPM, 1920x1080, built in HyperFrames.

## Styles
The user picked four styles from an 8-style board:
- **Liquid Glass:** a 3D phone with frosted glass UI.
- **Exploded UI:** isometric layers on a paper drawing.
- **Departures Board:** split-flap tiles.
- **Product:** the bet panel in gentle 3D with depth of field and HUD chrome, in the style of the Rounds reel.

Each scene change has its own transition (see `docs/TRANSITIONS.md`).

This folder is a standalone project. It is not part of the Next.js app, and the root `tsconfig.json` and `eslint.config.mjs` ignore `video/`.

## Layout
- `master/` is the full film, one HyperFrames project.
  - `index.html` and `compositions/sNN.html` are generated: run `node build/gen.mjs`, which reads `build/fx.js` (transitions) and `build/plan.json` (the shot plan).
  - `assets/` holds local gsap, three r147 + GLTFLoader + `iphone.glb` (glass shots), three r170 (exploded shots) and the fonts.
- `shots/<style>/` holds the per-style source projects the shots came from. Each one is generated:
  - flap: `build/gen.mjs`
  - macro (the product shots): `src/build.mjs`
  - expl: `src/build.mjs`
  - glass: `gen-index.py` (the kit is in `assets/glass/`)
- `audio/` holds the music and sound effects, both synthesized with numpy:
  - `score.py` is the original 120 BPM A-minor score.
  - `sfx.py` holds the transition sounds and in-scene action sounds.
- `docs/` holds the brief, the shot list (`SHOTS.md` plus `CHANGES-v2.md`), the seam plan and the build rules.
- `mako-market-ad.srt` is the caption track, and `claims.md` lists every on-screen claim with its source.

## Render
```bash
PR=~/.claude/plugins/cache/hyperframes/hyperframes/<version>
export HYPERFRAMES_BROWSER_PATH=/path/to/chrome-headless-shell   # cloud sessions only
cd master
node $PR/skills/hyperframes/scripts/plugin-cli.mjs check
node $PR/skills/hyperframes/scripts/plugin-cli.mjs render --fps 120 --output out/master-120.mp4   # about 70 min on 4 CPU workers
ffmpeg -i out/master-120.mp4 -vf "tmix=frames=2,framestep=2" -c:v libx264 -crf 16 -preset slow -pix_fmt yuv420p \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -movflags +faststart out/mako-ad-1080p60.mp4

uv run --with numpy python3 ../audio/score.py out/score.wav
uv run --with numpy python3 ../audio/sfx.py out/sfx.wav
ffmpeg -i out/score.wav -i out/sfx.wav -filter_complex "[1:a]volume=0.42[s];[0:a][s]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1:LRA=9" -ar 48000 out/mix.wav
ffmpeg -i out/mako-ad-1080p60.mp4 -i out/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart out/mako-market-ad-1080p60.mp4
```
The render flags above are a sketch. See `hyperframes-cli` for the exact flags of your version.

## Notes
- Shots never use `tl.set()` at local time 0, because a sub-composition can skip it when the playhead lands exactly on its start. Every chain starts with a `fromTo` that renders at load.
- The registry shader transitions (whip pan, domain warp, chromatic split, cross-warp, VHS) are rebuilt as live SVG filters, because the shipped blocks only capture static DOM and can't sample the live WebGL shots.
- `iphone.glb` and the liquid-glass base come from the HyperFrames registry (Apache-2.0, heygen-com/hyperframes).
