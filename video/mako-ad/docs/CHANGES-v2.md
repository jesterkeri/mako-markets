# Storyboard v2 changes (user feedback, approved to build after these)
The user: "use this style for them [the MACRO close-ups], reduce how often that type of scene shows, use good motion
design and transition effects, there should be a new transition [at every scene change]".
"This style" = the IN-THE-PRODUCT look from the earlier Rounds reel: reference frame $S/ad/ref-in-the-product.webp,
more frames in $S/remotion-test/out/storyboard/shot-*.png, source $S/remotion-test/src/film/AppPage.tsx and src/reel/kit.tsx.
Look: the real bet panel rebuilt big and readable (toggle, amount field "0.10 USDC", chips, wide yellow CTA) in gentle
3D perspective (a few degrees of rotateX/rotateY, not a steep macro tilt), the rest of the page (chart with yellow/red
candles, header bars) deeply out of focus behind/around it, the sharp panel itself fully readable, a cursor, yellow glow
on the active control, black ground. HUD chrome: thin white corner brackets, top-left logo + "MAKO MARKET · <CHAPTER>",
top-right "NN · <CHAPTER>", bottom-left film timecode HH:MM:SS:FF (60 fps, from the shot's film start), bottom-centre
"120 BPM · NN / 09", bottom-right "1920x1080 · 60P". Chapters (NN / 09): 01 HOOK, 02 ANYTHING, 03 SIGN IN, 04 BET,
05 PAYOUT, 06 HOST, 07 ROUNDS, 08 BOARD, 09 CTA.

## Shot table changes (all other rows of SHOTS.md unchanged)
| id | start-end | key | style | on-screen text | note |
| 01 | 0.0-2.0 | 1.6 | PRODUCT | (panel only) | Pools bet panel (YES/NO toggle, 0.10 USDC amount, chips 0.10 1 5 10 25 50, CTA "Confirm · 0.10 USDC"); slow push; cursor presses YES at ~1.0 s, YES glows. Opens lit. |
| 02 | 2.0-3.5 | 3.2 | PRODUCT | What happens next? | Focus racks off the panel (panel goes soft) and the headline lands sharp over it. |
| 14 | 16.5-18.0 | 17.4 | EXPL | No seed phrase / 01 EMAIL 02 CODE 03 WALLET | Sign-in card explodes into 3 labelled layers. |
| 15 | 18.0-19.5 | 19.0 | GLASS | Gas is paid for you / A bet costs only what you stake. | Glass badge (gas pump glyph) slides onto the phone. |
| 19 | 24.0-26.5 | 25.6 | EXPL | Pick YES or NO. | (extended to 2.5 s, absorbs old 20) |
| 20 | REMOVED | | | | |
| 22 | 28.0-29.5 | 29.0 | PRODUCT | Confirm · 0.10 USDC | Same panel, different angle; YES already picked; cursor presses the CTA, it glows. |
| 28 | 38.0-40.0 | 39.4 | PRODUCT | Refund / No fee on refunds. | A settled pool card with a cyan (#06B6D4) "Refund" status pill and button; headline lands. |
| 34 | 49.0-51.0 | 50.4 | PRODUCT | Prices from Chainlink. | Round page: chart with candles (no axis values) and the UP/DOWN panel; focus racks to the headline. |
| 37 | unchanged MACRO | | | | |
Result: 38 shots; product-style close-ups drop from 9 to 4 (+ the 02 headline beat).
