# Seam plan: a different transition at (almost) every scene change
User: "use good motion design and transition effects... there should be a new transition". So no transition type repeats,
except the 05-10 board flips where the split-flap flip itself IS the transition (hard cuts on the beat, board identical).
Sources: hyperframes-animation transitions (catalog.md + css-*.md + @hyperframes/shader-transitions) and registry blocks
(whip-pan, flash-through-white, chromatic-radial-split, cross-warp-morph, domain-warp-dissolve, transitions-*).
Timing: each transition is centred on the cut time (the shot boundary in SHOTS.md), 0.25-0.5 s long unless noted, so the
picture still lands on the beat. Overlap = the outgoing shot holds/extends, the incoming starts early (registry injector
model). Brand colours only in any overlay (yellow #FACC15, ink, paper; red only on NO beats). No mascot, no em dashes.

| seam | cut at | transition | note |
|---|---|---|---|
| 01>02 | 2.0 | focus pull (css-dissolve) | same panel, match on action; outgoing blurs out as headline shot sharpens |
| 02>03 | 3.5 | glitch slam with RGB split (css-distortion glitch) | short and hard, 0.25 s |
| 03>04 | 5.0 | light leak in signal yellow (css-light) | warm wash into the glass world |
| 04>05 | 7.0 | zoom through (css-scale) | push into the slab, land on the board |
| 05>06..09>10 | 8,9,10,10.5,11 | hard cuts, the board flips | board layout identical |
| 10>11 | 11.5 | shutter (css-mechanical) | |
| 11>12 | 13.0 | circle iris opening from the YES tile (css-radial) | |
| 12>13 | 15.0 | 3D card flip (css-3d) | |
| 13>14 | 16.5 | directional blur through (css-blur) | dark to paper: pair with a quick colour dip in the blur |
| 14>15 | 18.0 | diagonal split (css-radial) | |
| 15>16 | 19.5 | vertical push, up (css-push) | |
| 16>17 | 21.0 | staggered blocks in yellow (css-cover) | full-frame blocks |
| 17>18 | 22.0 | colour dip through paper #EBE5D9 (css-dissolve) | black board to paper drawing |
| 18>19 | 24.0 | zoom punch (scale 1 > 1.12 snap + 2 frame white flash) | same card, match cut |
| 19>21 | 26.5 | squeeze (registry squeeze) | |
| 21>22 | 28.0 | whip pan (registry whip-pan) | motion blur streak |
| 22>23 | 29.5 | domain-warp dissolve (shader) | |
| 23>24 | 32.0 | horizontal blinds (css-cover) | |
| 24>25 | 33.5 | diamond iris (css-radial) | |
| 25>26 | 35.0 | chromatic radial split (registry) | |
| 26>27 | 36.5 | VHS tape (css-distortion) | |
| 27>28 | 38.0 | grid dissolve (css-grid, brand colours only) | |
| 28>29 | 40.0 | gravity drop (css-other) | outgoing falls away |
| 29>30 | 42.0 | elastic push, left (css-push) | |
| 30>31 | 43.5 | film burn (css-light) | |
| 31>32 | 46.0 | clock wipe (css-mechanical) | chapter turn to ROUNDS |
| 32>33 | 47.5 | morph circle in yellow (css-other) | |
| 33>34 | 49.0 | zoom out (css-scale) | |
| 34>35 | 51.0 | ripple (css-distortion) | |
| 35>36 | 52.5 | vertical blinds (css-cover) | |
| 36>37 | 54.0 | flash through white (registry) | |
| 37>38 | 56.0 | cross-warp morph (registry, shader) | |
| 38>39 | 58.5 | blur crossfade, slow 0.6 s (registry blur-crossfade) | calm landing on the end card |
If a transition breaks a shot's WebGL or costs too much render time, swap in another UNUSED type from the catalog and log it.
