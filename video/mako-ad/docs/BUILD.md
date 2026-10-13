# Storyboard build rules (all builders)
Read first: $S/board3/BRIEF.md (brand, machine notes, CDN workarounds) and $S/ad/SHOTS.md (the shot list).
S=/tmp/claude-0/-home-user-mako-markets/71601d9e-4a9c-5638-8755-dce95a1141c6/scratchpad

This is step 3 (storyboard). Build ONLY your style's shots, so that the approved board animates directly later:
- Your own HyperFrames project: $S/ad/<style>/ (copy the setup from your style's board3 work folder).
- Each shot is its own sub-composition file: $S/ad/<style>/compositions/sNN.html (data-composition-id="sNN",
  duration = shot length, local time 0 = shot start). Follow hyperframes-core's sub-composition contract exactly so the
  files can later be copied into one master project. Shared assets go in $S/ad/<style>/assets/ (local gsap/three, fonts).
- Your index.html places your shots one after another (any order) just so you can lint/snapshot/render them.
- Each shot fully animated (in, hold, and the motion in the note), seek-safe, deterministic, one paused GSAP timeline.
- Never open a shot on an empty frame; the first frame of every shot must already show the subject (cuts are hard cuts
  on the beat; the master will add transitions).
- Storyboard still for each shot: $S/ad/storyboard/sNN.png, 1920x1080, taken at the shot's key time
  (key minus start, in local time). Use `snapshot --at` on your index timeline.
- Keep the look of your board3 frame (it was approved). Same palette, type, chrome.
- Exact on-screen text from SHOTS.md, no extra claims, no em dashes, "Mako Market" singular, no mascot.
- Run lint (0 errors). Check every still once yourself for clipped text, wrong copy, empty frames.
- Do NOT render final MP4s (a 1-pass low-res preview is fine if you need it). Do NOT touch the git repo.
- Final report: one line per shot (id: ok / problem), plus anything I must know. Short.
