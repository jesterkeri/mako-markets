# Mako Market full ad: style board (shared brief for every builder)

Scratch root: S=/tmp/claude-0/-home-user-mako-markets/71601d9e-4a9c-5638-8755-dce95a1141c6/scratchpad
Output dir: $S/board3/  (write ONLY your own files there: N.png and N.mp4, plus a work folder $S/board3/work-N/)
Do NOT touch the git repo at /home/user/mako-markets except to READ components for UI reference. Never commit.

## The film
60 s, 16:9 (1920x1080), music + captions, audience everyday crypto users. A full ad for makomarket.xyz
(the whole product, not only Rounds). The user asked for "something different": every style must break
from the earlier Rounds reel look (that was: a paper-coloured 3D tilted app page, black type-on-black cards,
grain). High quality: premium launch-film / showreel level, never slides, never clip-art.

## Deliverable per style (this is the style board, step 2. NOT the film)
- N.png: one 1920x1080 still of the SAME hook moment (below).
- N.mp4: a 3 to 4 s motion clip of that hook moment, 1920x1080, 30 fps, H.264 yuv420p, silent, under 6 MB.
- One line in your final report: style name, feel (8 words max), engine + skill/preset/block actually used.

## Hook moment (same in every style)
Headline: "What happens next?"   Second line: "Bet YES or NO."
Plus a stylised Mako Market pool card (a YES/NO market) or the product UI in the style's own language.
Optional supporting words (real app copy only): "Crypto. Football. NBA. Forex. Commodities. Stocks.",
"Bet in seconds.", "Gas is paid for you", "Min 0.10 USDC", "makomarket.xyz".
A sample pool question may be illustrative, with NO numbers that read as real data (no odds, pot sizes,
balances, percentages, bettor counts). Charts may appear but with no axis values.

## Brand (fixed; only the motion style varies). Source: /home/user/mako-markets/.claude/BRAND.md
- Colours: paper #EBE5D9 / #E1DBCB / #D6CFBE, ink #000, signal yellow #FACC15 (the accent; YES/UP).
  Red #D94A3D ONLY for NO/DOWN/loss. Dark UI surface #121212 / #1c1c1c, light text #EDE6D6.
  A style may push the palette (e.g. mostly black, mostly yellow, mostly paper) but no new hues as accents.
- Fonts: Bricolage Grotesque 800 (display), Inter (body), JetBrains Mono (labels). Local CSS with @font-face:
  $S/fonts/inline-fonts.css (base64, works from any folder) and $S/fonts/jbmono-latin.woff2.
  Wait for `document.fonts.ready` (and document.fonts.load for each face) before any capture.
- Logo (shark fin mark) SVG: viewBox="-3 -3 406 316", path d="M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z". Wordmark "Mako Market".
- Voice: "Mako Market" singular; never we/our/us/team; NO em dashes anywhere; plain words.
- NO mascot/character. NO neobrutalism (no hard offset shadows, no thick outlines on cards; outline TYPE is ok).
- UI reference (stylise and simplify, never copy 1:1): repo src/app/pools/, src/components/ (pool card, bet panel
  with YES/NO toggle, amount chips 0.10 / 1 / 5 / 10 / 25 / 50), and screenshots:
  $S/rounds-hf/capture/screenshots/full-page.png, $S/live/home.jpg, $S/roundspost/screen.html (a dark mobile UI mock).

## Machine notes (cloud container, CPU only, network allowlisted)
- cdn.jsdelivr.net and most CDNs are BLOCKED. Use local libs:
  gsap: $S/hf-cartesian/gsap.min.js ; three: $S/three-test/node_modules/three/build/three.module.min.js
  (examples/jsm under $S/three-test/node_modules/three/examples/jsm). Rewrite any CDN <script> src in blocks to local copies.
- Chromium: /opt/pw-browsers/chromium-1194/chrome-linux/chrome ; headless shell:
  /opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
  For WebGL use flags --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader.
- Serve over HTTP (python3 -m http.server <port> in the work folder), not file:// (canvas taint). Use your assigned port.
- ffmpeg is installed. playwright-core is in $S/three-test/node_modules and $S/remotion-test/node_modules.
- HyperFrames CLI: PR=/root/.claude/plugins/cache/hyperframes/hyperframes/0.8.150 ;
  node $PR/skills/hyperframes/scripts/plugin-cli.mjs <cmd> ; export HYPERFRAMES_BROWSER_PATH=<headless shell path>.
  A working project to copy the setup from: $S/hf-cartesian (index.html, frame.md, gsap.min.js, capture/, assets/fonts).
  Brand capture already done: $S/rounds-hf/capture (do not re-capture). Brand remix of a preset:
  node $PR/skills/faceless-explainer/scripts/build-frame.mjs --preset <name> (read its --help first).
  Composition contract: #root[data-composition-id], clips class="clip" with data-start/data-duration/data-track-index,
  one paused GSAP timeline registered at window.__timelines["<id>"]. Run lint, snapshot, render.
- Keep token use lean: don't read big images repeatedly; check your still once at the end.
