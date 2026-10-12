---
name: mako-video
description: The Mako Market video process. Use for ANY request to make a Mako video, animation, promo, launch film, motion graphic or storyboard. Runs four gated steps — brief, style board, 8-scene storyboard, animation — and never moves to the next step without the user's go. Sits on top of the motion skills (product-film, hyperframes, business-motion-film, threejs-*), which supply the craft.
---

# Mako video process

Four steps. Each one ends with something the user can look at, and stops there.
Never start the next step, or generate anything ahead of it, until the user says go.

```
1. Brief  →  2. Style board  →  pick  →  3. Storyboard (8 scenes)  →  approve  →  4. Animate
```

## Brand stays fixed. Style varies.

A "style" is how the film moves and is shot. It is never a new brand. Every style uses:

- **Colour.** Paper `#EBE5D9` / `#E1DBCB` / `#D6CFBE`, ink `#000`, signal `#FACC15`. Status colours: live `#D946EF`, closed `#F59E0B`, settling `#8B5CF6`, won `#14B8A6`, refunded `#06B6D4`.
- **Red rule.** Only DOWN / NO / loss get red: fill `#D94A3D`, text on paper `#B3362B`. Nothing else is red.
- **Type.** Bricolage Grotesque 800 for display, Inter for body, JetBrains Mono for numbers and labels.
- **Real product.** Screens come from makomarket.xyz or the design system (`public/designsystem/`). Never invent UI.
- **Assets.** The logo is `public/logos/mako-logo.svg`. Mascot poses are in `public/designsystem/mako/*.webp`.
- **Voice.** Copy is in team voice ("we", "with us"). Plain words. No hype.

## 1. Brief

Get these, from the request or by asking once:

- **Goal.** What should the viewer do or feel?
- **Where.** Platform and aspect ratio: 16:9 for desktop/X, 1:1 for the feed, 9:16 for stories.
- **Length.** Usually 10–30 s.
- **Message and CTA.**
- **Must-show.** Pages, features or mascot poses that have to appear.

Write it back in five lines and wait for "go".

## 2. Style board

Show **6 styles**, each as **one still of the same moment** (the key message frame), so the user compares like with like.

- **Picking styles.** Choose them from the menu below to fit the brief. Mix in a new style when the brief calls for one.
- **Deliver.** A contact sheet plus each still on its own.
- **Caption each style with:**
  - its name
  - one line on the feel
  - the engine that will build it
  - a reference: a prompt-motion.com entry or a skill example

Then stop. The user picks one style, or mixes two.

| Style | Feel | Engine |
|---|---|---|
| 3D Devices | Real phone and laptop in Three.js, studio light, depth of field, slow camera | `threejs-*`, `business-motion-film` (product-hero-realism) |
| Product Close-up | Rebuilt Mako UI, camera glides across components, cursor taps | `product-film` or `product-launch-video` |
| Kinetic Terminal | Type-led, ticking mono numbers, countdowns, UP/DOWN hits | `motion-graphics` |
| Paper Editorial | The design system as film: paper, grid, ink, measured cuts | `hyperframes` (Swiss Pulse style) |
| Mascot Story | Mako the shark carries the story pose to pose | `general-video` with mascot WebPs |
| Market Data | Candles, pools and odds as abstract motion, chart hits | `motion-graphics` (data-in-motion) |

## 3. Storyboard: 8 scenes

Make **8 stills** in the chosen style, at the brief's aspect ratio. Under each still:

- `#` and duration (the durations add up to the brief's length)
- on-screen text, exactly as it will read
- motion: what moves, the camera move, and the transition out
- sound cue

**Deliver** a contact sheet plus each scene on its own. The user approves or edits scene by scene. Redo only the scenes they flag.

## 4. Animate (only after the storyboard is approved)

- **The approved stills are the contract.** Every scene must land on its still.
- **Build** with the engine of the chosen style. Use one engine per film; never mix Remotion and HyperFrames.
- **Draft first.** Render a 540p draft and make a contact sheet with one frame per scene. Check it against the storyboard and fix drift before showing the user.
- **Final.** 1080p (or the brief's size) at 60 fps, with sound mixed to about −14 LUFS. Deliver an MP4 and a poster frame.

## Environment notes (cloud sessions)

- Chromium is at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
- For HyperFrames, set `HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell`.
- WebGL needs `--use-angle=swiftshader --enable-unsafe-swiftshader`.
- If `cdn.jsdelivr.net` is blocked, install GSAP or three from npm and load them locally.
- For live screenshots of makomarket.xyz:
  - Trust the proxy CA in NSS.
  - Reload until React hydrates.
  - Stub `/api/feedback` so nothing is sent.
  - Use `:visible` locators.
