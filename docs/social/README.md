# Mako Market social posts

## News post format (approved)

Lead with the news, then ask the market. Nigerian news first, then the rest.

1. Open with one or two lines of Nigerian news (what happened, plain words).
2. The Nigerian markets as questions, each on its own line with 🇳🇬.
3. "Meanwhile," + one line of the other news (world, markets, sport) and its markets
   (📉 / 📊 / ⚽ / 🏀 as fits).
4. Close with `YES or NO 👇` and `makomarket.xyz`.

Example:

```
Nigeria's state police amendment now needs Tinubu's signature. And he wants Nigerians convicted abroad to serve their sentences at home.

🇳🇬 Will Tinubu sign the state police amendment by Nov 2?
🇳🇬 Will the Senate pass his bill letting Nigerians jailed abroad serve time at home by Nov 6?

Meanwhile, China's AI stocks just lost $480B and Alphabet sank 12% on earnings:
📉 Will the Nasdaq fall into a correction by Nov 5?
📊 Palantir reports Monday. Will it beat estimates?

YES or NO 👇
makomarket.xyz
```

One post per market uses the same order (Nigeria first): a news line, then
`Will ...?`, then `makomarket.xyz`.

Rules:
- Every news line must be verified this week; never invent numbers or odds.
- Only quote pool odds once a pool has bets ("[X]% of the pool is on YES ...").
- "Mako Market" singular, never "we/our/us", no em dashes.
- Relative days ("Monday") only if the post goes out before that day.

## Pool post image

`pool-post-card/` renders the approved pool card (black grid, cream question card, yellow YES and red
NO cards), 2400x1350 for X. See `pool-post-card/example.png`.

```
cd docs/social/pool-post-card
npm pack @fontsource-variable/bricolage-grotesque @fontsource-variable/inter @fontsource/jetbrains-mono
mkdir -p fonts && for f in *.tgz; do tar xzf "$f" --strip-components=2 -C fonts --wildcards '*latin-wght-normal.woff2' '*latin-500-normal.woff2' '*latin-700-normal.woff2' 2>/dev/null; done; rm *.tgz
node render.js   # edit the `pools` list in render.js first
```

Each pool needs: `kicker` (top-right mono line), `cat` (category pill), `q` (exact pool question),
`sub` (`Betting closes <Day> <D> <Mon>, <HH:MM> WAT · Hosted by Mako Market`), `pc` (`<Day> <HH:MM>`),
`yes` / `no` (one short line each), `out` (file name).
