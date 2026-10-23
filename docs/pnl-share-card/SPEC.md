# Share cards: bet placed, win, loss

The cards a user shares from the app. They are part of the app UI, not marketing posts. One layout, three
variants:

- **Bet placed** (lever art): shared right after a bet goes in, while the pool is still open.
- **Win** (rocket art) and **loss** (crying mascot art): shared after the pool settles, picked by the result.

| File | What it is |
| --- | --- |
| `render-placed.png`, `render-win.png`, `render-loss.png` | The approved designs. Match these. |
| `placed.html`, `win.html`, `loss.html` | The exact markup and CSS the renders came from (open in a browser; fonts load from Google Fonts). |
| `../../public/share/bet-placed.png` | Bet placed background art, 1670x942 PNG, full quality. |
| `../../public/share/pnl-win.png` | Win background art, 1672x941 PNG, full quality. |
| `../../public/share/pnl-loss.png` | Loss background art, 1672x941 PNG, full quality. |
| `../../public/share/qr-makomarket.png` | QR code for `https://makomarket.xyz`, dark on cream, no quiet zone (the tile adds the padding). |

## Canvas

- 1600 x 900 PNG (16:9). Black (`#000`) behind everything.
- Background art fills the canvas: `cover`, anchored right bottom.
- A left-to-right shade sits over the art so the text column stays readable:
  `linear-gradient(90deg, rgba(0,0,0,.85) 0%, rgba(0,0,0,.4) 50%, rgba(0,0,0,0) 66%)`.
- Four corner brackets, 56px, 2px stroke, `rgba(237,230,214,.7)`, inset 36px from each edge.
- No glow, grain or vignette. These were tried and removed.

## Tokens

| Token | Value | Used for |
| --- | --- | --- |
| YES / profit | `#16A34A` (`--mako-yes`) | Win return, profit line |
| NO / loss | `#E53935` (`--mako-no`) | Loss return, loss line, "Missed it" status |
| Side on yellow (YES) | `#0D6B30` | Side value inside the yellow pill only (the site green is too pale on yellow) |
| Side on yellow (NO) | `#B71C1C` | Same, for NO |
| Won | `#14B8A6` | "Called it" status |
| Live | `#D946EF` | "Call live" status (bet placed) |
| Signal yellow | `#FACC15` | BETA tag, stats pill, url pill, avatar fallback, win reticle |
| Cream | `#EDE6D6` | Body text, brand name, handle |
| Title cream | `#F4EFE4` | Market question |
| Muted | `#8a857a` | Labels, unit words, date |
| Ink | `#0A0A0A` | Text inside the yellow pill |

Fonts: Bricolage Grotesque 800 (display and numbers), Inter 500/700 (unit words), JetBrains Mono 700 (small
uppercase labels). Rule: mono is only for labels; every number is Bricolage.

## Layout (left column x = 76px)

Top to bottom:

1. **Header**, top 66px, spans 76px to 1524px.
   - Left: logo mark (46px wide), "Mako Market" (Bricolage 800, 32px, -0.03em), BETA tag (JetBrains Mono
     700 13px, 0.14em, black on `#FACC15`, radius 7px, padding 5px 9px, 10px left margin).
   - Right: status. Mono 700 18px, 0.16em, uppercase, with an 11px dot (5px soft ring at 22% of the colour).
     Win: "Called it" in `#14B8A6`. Loss: "Missed it" in `#E53935`.
2. **Category label**, top 150px: mono 700 15px, 0.12em, uppercase, muted. Text: `The call · {Category} pool`.
3. **Market question**, 12px below: Bricolage 800 66px, line-height 1, -0.04em, `#F4EFE4`, max width 900px.
4. **Return block**, top 300px:
   - Label "Return" (mono label style).
   - Return %: Bricolage 800 186px, line-height 0.9, -0.055em, in the result colour. A "+" value is pulled
     left by 0.035em for optical alignment; a "-" value is not. The sign is followed by a 0.09em gap so it
     never touches the first digit.
   - 14px below, baseline-aligned row with a 12px gap: amount (`+6.17 USDC` / `-10.00 USDC`, Bricolage 800
     36px, result colour) then the word `profit` / `loss` (Inter 500 24px, muted).
5. **Stats pill**, top 594px: solid `#FACC15`, fully rounded (radius 999px), padding 22px 52px 24px, sized
   to its content. Three columns, Side / Stake / Payout:
   - Column padding 0 34px; 2px dividers `rgba(10,10,10,.28)` between columns (none before the first).
   - Label: mono 700 15px uppercase in `#0A0A0A` at 78% opacity.
   - Value, 10px below: Bricolage 800 36px, `#0A0A0A`. Unit `USDC` after it: Inter 700 18px, `#0A0A0A` at
     72% opacity, 6px left margin.
   - Side value uses the darker side colour (`#0D6B30` / `#B71C1C`).
   - No border, no highlight, no inner chip. Anything that makes it look tappable was rejected.
6. **Footer row**, bottom 58px, height 84px, left 76px to right 76px, everything vertically centred so the
   handle lines up with the url pill:
   - Left: 64px avatar circle (3px black ring, then 2px `rgba(237,230,214,.5)` ring), 16px gap, handle
     (Bricolage 800 28px, line-height 1). The date sits 8px under the handle (mono 14px, muted, uppercase,
     `DD Mon YYYY`) and is positioned absolutely so it does not push the handle off the centre line.
   - Right: QR tile (84px, `#EDE6D6`, radius 14px, padding 9px) then a 14px gap and the url pill
     (`makomarket.xyz`, Bricolage 800 28px, black on `#FACC15`, radius 999px, padding 16px 30px).

The layout above is written for the win and loss cards. The bet placed card changes these parts and keeps
everything else:

## Bet placed variant

- Art: `bet-placed.png` at `right -20px bottom 10px / 1440px auto` (not `cover`), so the lever clears the
  stats pill. Same left-to-right shade over it.
- Status: "Call live" in `#D946EF` (the site's live colour).
- Return block label: "My call". The big value is the side word (`YES` / `NO`) in the side colour
  (`#16A34A` / `#E53935`), same size and weight as the return %, with no optical pull to the left.
- Line under it: estimated return % (e.g. `+64%`, profit green) then `est. return if right` (Inter 500 24px,
  muted). Return = (estimated payout - stake) / stake, same formatting rules as the return %.
- Stats pill columns: Stake, Est. payout, Settles. Settles is the settlement date as `Sat 25 Oct` (no unit).
- No reticle.
- The estimate is only an estimate: it moves as other people bet. Work it out from the pool's state at the
  moment the card is made and always keep the "est." / "Est." labels. If a pool type cannot give a reliable
  estimate, drop the Est. payout column and the estimate line rather than guess.
- The QR code on this card should open the pool page, so someone who scans it can take the other side.

## Win reticle

**Win only:** a reticle over the rocket. 130px circle, 2px `rgba(250,204,21,.9)`, at left 1366px top 214px,
with four 22px tick marks outside it. Label to its upper left, right-aligned in a 200px box at left 1146px
top 166px: "Target locked" (mono, yellow) over the return % (result colour). The loss card has no reticle.

## Data

| Field | Source | Format |
| --- | --- | --- |
| Category | pool market type (`marketTypeLabel`) | `The call · Football pool` |
| Question | pool question | as written |
| Side | the user's side | `YES` / `NO` |
| Stake | amount staked | 2 decimals + `USDC` |
| Payout | amount received | 2 decimals + `USDC` (`0.00` on a loss) |
| Profit / loss | payout - stake | sign + 2 decimals + `USDC` |
| Return | (payout - stake) / stake | sign + 1 decimal + `%`; drop a trailing `.0` (`-100%`) |
| Handle | user display handle | `@handle` |
| Avatar | user avatar | image in the 64px circle; fallback is the first letter on yellow |
| Date | settlement date (win/loss), bet date (bet placed) | `23 Oct 2026` (rendered uppercase) |
| Est. payout | bet placed only: the pool's current estimate for this position | 2 decimals + `USDC` |
| Settles | bet placed only: pool settlement time | `Sat 25 Oct` |
| Target | price pools only (crypto, forex, metals, stocks): the target in the pool's settlement reference | `Above $83,368`, `Below 1.1`; the last stats pill column on all three cards. Added in the app (owner, 2026-10-23); entry and current prices follow from the price recorder |

Bet placed is shown for an open position. After settlement, pick the variant from the result: payout > stake is a win, payout = 0 is a loss. Refunded or voided
positions are not covered by this design; do not show a win or loss card for them.

A win or loss card's figures are final: they come only from a pool settled in the last finalized block. The image is
still cached a minute at most, because it carries the account's current name and photo, and a rename or a removed photo
must show on the next render. Each card image has one URL, `<card page>/image.png`, and any query string on it is refused.

## Copy rules

- The brand is "Mako Market" (singular). Never "we", "our" or "us" on the card.
- No em dashes anywhere.
- Every figure on the card comes from the user's real position. No made-up numbers.

## Long questions

The approved design fits "Will Arsenal win on Saturday?" on one line. Longer questions must not collide with
the Return block. Either lay the left column out as a vertical stack (so a two-line question pushes the
blocks down) or step the question size down by length, and clamp it to two lines. Test with a ~90 character
question before shipping.
