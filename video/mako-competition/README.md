# Mako Market $100 trading competition video

A 48.5 s, 16:9 announcement for X, built in HyperFrames. The look is a sports-and-markets broadcast that
covers every Mako Market category: each scene sits on a different arena (football pitch, NBA court, crypto
chart, politics seating chart), the open and close show all four as a video wall, and the scorebug tag
switches with them. A schedule card, invite cards, a leaderboard, a prize podium, an "under review" banner
and a live ticker carry the facts. Music and sound effects, no voiceover; every fact is on screen, so it
works muted.

Every on-screen fact comes from the brief and is listed in `claims.md`. Weekday names and "tomorrow" are
left out on purpose: the video is posted on the start day.

This folder is a standalone project. It is not part of the Next.js app.

## Scenes

| Time | Scene |
| --- | --- |
| 0.0 to 4.5 s | Open: "$100 trading competition", lower third |
| 4.5 to 9.5 s | Schedule: starts, ends, 14 days |
| 9.5 to 16.5 s | How to enter: invite 2 friends |
| 16.5 to 22.0 s | Entry rules: invite codes |
| 22.0 to 28.0 s | How players are ranked: the profit formula |
| 28.0 to 35.5 s | The small print: four ranking rules |
| 35.5 to 42.5 s | Prizes: podium count-up, under review |
| 42.5 to 48.5 s | Live standings, start time, lockup |

## Layout

- `build/gen.py` generates `index.html` (arena backgrounds, scorebug, ticker, stinger wipes) and `compositions/s1.html`
  to `s8.html`. Edit it, then run `python3 build/gen.py`.
- `audio/sound.py` synthesizes the music bed and sound effects with numpy. Its cut times match `SCENES` in
  `gen.py`.
- `assets/` holds local gsap, the Mako Market logo and the brand fonts (Bricolage Grotesque, Inter,
  JetBrains Mono).

## Render

```bash
PR=~/.claude/plugins/cache/hyperframes/hyperframes/<version>
export HYPERFRAMES_BROWSER_PATH=/path/to/chrome-headless-shell   # cloud sessions only
python3 build/gen.py
node $PR/skills/hyperframes/scripts/plugin-cli.mjs check
node $PR/skills/hyperframes/scripts/plugin-cli.mjs render --fps 60 --quality delivery --output out/video-60.mp4
python3 audio/sound.py out/sound.wav
ffmpeg -i out/sound.wav -af "loudnorm=I=-14:TP=-1:LRA=9" -ar 48000 out/mix.wav
ffmpeg -i out/video-60.mp4 -i out/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest \
  -movflags +faststart out/mako-market-100-competition.mp4
```
