# Mako Market Rounds reel (30 s)

The source for the 30 s Rounds showreel: 23 shots at 120 BPM, 1920x1080.
It is built with Remotion following the product-film skill.
Style 7 ("In the product", the round page in 3D) is the main look, with style 6 (type on black) and style 8 (paper) as accents.

This folder is a standalone project. It is not part of the Next.js app, and the root `tsconfig.json` and `eslint.config.mjs` ignore it.

## Layout

- `src/reel/` holds the film:
  - `shots.tsx` is the shot table: id, chapter, start, end, keyframe, note and component.
  - `kit.tsx` holds the chrome, grain, 3D page stage, type stacks, slash wipe, particle sphere and captions.
  - `Reel.tsx` puts each shot in its own `<Sequence>`.
  - `ShotList.tsx` is the storyboard sheet.
- `src/film/` holds the three style tests (Signal, In the product, Paper) and `AppPage.tsx`, the frame-driven copy of the real round page.
- `src/kit/` is the product-film kit: springs, camera, cursor, punchlines and dither.
- `scripts/`:
  - `reel-stills.ts` renders the 23 keyframe stills.
  - `finish.sh` runs the motion blur and encode.
  - `contact.py` builds the board-vs-film contact sheet.
- `audio/`:
  - `score.py` is the original 120 BPM A-minor score, synthesized with numpy.
  - `sfx.py` holds the UI sound effects, placed on exact cue frames.
- `mako-market-rounds.srt` is the caption track. `claims.md` lists every on-screen claim with its source.

## Rebuild

```bash
npm install
# Optional: point at a local Chrome or headless shell (needed in cloud sessions).
export REMOTION_BROWSER=/path/to/headless_shell

# Storyboard stills (about 25 s). ShotList reads them from public/storyboard/.
npx tsx scripts/reel-stills.ts

# 240 fps master, then motion blur (180 degree shutter) and BT.709 H.264 at 60 and 30 fps
npx remotion render Reel out/film/master-240.mp4 --props='{"fps":240}' --image-format=png --crf=8 --pixel-format=yuv444p --concurrency=4
bash scripts/finish.sh

# Audio: score and sound effects, mixed to about -14 LUFS, then muxed onto the silent picture
uv run --with numpy python3 audio/score.py out/score.wav
uv run --with numpy python3 audio/sfx.py out/sfx.wav
ffmpeg -i out/score.wav -i out/sfx.wav -filter_complex "[1:a]volume=0.32[s];[0:a][s]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1:LRA=9" -ar 48000 out/mix.wav
ffmpeg -i out/film/mako-rounds-1080p60.mp4 -i out/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -shortest -movflags +faststart out/mako-market-rounds-1080p60.mp4
```

## Timings

- The master render takes about 21 minutes on 4 CPU workers. The blur and encode take about 7 minutes.
- To change a single shot, edit its entry in `shots.tsx` and re-render.
- Sound effect cues come from the shot source:
  - UP tap: 5.45 s
  - 0.10 chip tap: 8.05 s
  - START lock: 16.45 s
  - CLOSE lock: 17.2 s
  - email typing: 26.15 to 26.75 s

## Open questions

- Fee wording: "to the round's host" (from the brief) or "to the house" (what the app says).
- App wording that differs from the brief: "Continue" in the film, where the app says "Email me a code"; "Gas covered" in the film, where the app says "Gas is paid for you".
