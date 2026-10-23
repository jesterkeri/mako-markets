#!/usr/bin/env python3
"""Generate index.html and compositions/sN.html for the $100 trading competition video.

Match-day broadcast look: a mown pitch behind everything, a scorebug, a bottom ticker and
stinger wipes between scenes live in index.html; each scene is a sub-composition.
Every on-screen fact comes from ../claims.md. Edit this file, then run: python3 build/gen.py
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W, H = 1920, 1080

# Scene boundaries (seconds). A stinger wipe covers each cut.
SCENES = [
    ("s1", 0.0, 4.5),
    ("s2", 4.5, 9.5),
    ("s3", 9.5, 16.5),
    ("s4", 16.5, 22.0),
    ("s5", 22.0, 28.0),
    ("s6", 28.0, 35.5),
    ("s7", 35.5, 42.5),
    ("s8", 42.5, 48.5),
]
TOTAL = SCENES[-1][2]

PITCH, PITCH2 = "#0D3B2A", "#0B3324"
INK, PAPER, ACCENT, MUTED, RED = "#0C1410", "#F6F4EE", "#FACC15", "#A9C4B4", "#E53935"

LOGO_PATH = ("M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 "
             "C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 "
             "C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z")


def logo(cls, color="currentColor"):
    return f'<svg class="{cls}" viewBox="-3 -3 406 316"><path d="{LOGO_PATH}" fill="{color}"/></svg>'


FONTS = """
@font-face{font-family:"Bricolage";font-weight:200 800;src:url("assets/fonts/bricolage.woff2") format("woff2-variations")}
@font-face{font-family:"Inter";font-weight:100 900;src:url("assets/fonts/inter.woff2") format("woff2-variations")}
@font-face{font-family:"JetBrains Mono";font-weight:400 800;src:url("assets/fonts/jbmono.woff2") format("woff2")}
"""

# Shared scene vocabulary, scoped per scene root so templates never collide.
def base_css(sid):
    r = f"#{sid}-root"
    return f"""
{r}{{position:absolute;inset:0;overflow:hidden;color:{PAPER};font-family:"Inter",sans-serif}}
{r} .chip{{position:absolute;display:flex;align-items:center;gap:14px;height:52px;padding:0 22px;background:{ACCENT};color:{INK};font:800 24px/1 "JetBrains Mono",monospace;letter-spacing:.14em;text-transform:uppercase}}
{r} .chip i{{display:block;width:12px;height:12px;background:{INK}}}
{r} .h1{{position:absolute;font:800 96px/1 "Bricolage",sans-serif;letter-spacing:-.03em}}
{r} .body{{position:absolute;font:500 36px/1.3 "Inter",sans-serif}}
{r} .mono{{font-family:"JetBrains Mono",monospace;font-weight:700;letter-spacing:.12em;text-transform:uppercase}}
{r} .y{{color:{ACCENT}}}
"""


def scene_file(sid, dur, css, html, js):
    return f"""<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>{sid}</title></head>
  <body>
    <template id="{sid}-template">
      <style>{FONTS}{base_css(sid)}{css}
      </style>
      <div id="{sid}-root" data-composition-id="{sid}" data-width="{W}" data-height="{H}" data-duration="{dur}">
{html}
      </div>
      <script>
        (function () {{
          var R = "#{sid}-root ";
          function q(s) {{ return R + s; }}
          var tl = gsap.timeline({{ paused: true }});
{js}
          window.__timelines["{sid}"] = tl;
        }})();
      </script>
    </template>
  </body>
</html>
"""


scenes = {}

# S1: broadcast open, title and lower third.
scenes["s1"] = (
    """
#s1-root .beam{position:absolute;top:-200px;width:900px;height:1500px;background:radial-gradient(closest-side,rgba(246,244,238,.16),rgba(246,244,238,0));}
#s1-root .b1{left:-260px}
#s1-root .b2{right:-260px}
#s1-root .pre{position:absolute;left:120px;top:250px;font-size:28px;color:#FACC15}
#s1-root .big{position:absolute;left:104px;top:290px;font:800 330px/1 "Bricolage",sans-serif;letter-spacing:-.05em;color:#FACC15}
#s1-root .sub{position:absolute;left:120px;top:630px;font:800 124px/1 "Bricolage",sans-serif;letter-spacing:-.03em;text-transform:uppercase}
#s1-root .lt{position:absolute;left:120px;top:830px;display:flex;height:76px}
#s1-root .lt b{display:flex;align-items:center;padding:0 28px;background:#F6F4EE;color:#0C1410;font:800 38px/1 "Bricolage",sans-serif}
#s1-root .lt span{display:flex;align-items:center;padding:0 28px;background:#0C1410;color:#F6F4EE;font:500 32px/1 "Inter",sans-serif}
""",
    """
        <div class="beam b1"></div><div class="beam b2"></div>
        <div class="pre mono">Mako Market presents</div>
        <div class="big">$100</div>
        <div class="sub">Trading competition</div>
        <div class="lt"><b>Mako Market</b><span>Prediction market app on Monad testnet</span></div>
""",
    """
          tl.fromTo(q(".b1"), { rotation: -18, opacity: .5 }, { rotation: 10, opacity: 1, duration: 4.5, ease: "sine.inOut" }, 0);
          tl.fromTo(q(".b2"), { rotation: 18, opacity: .5 }, { rotation: -10, opacity: 1, duration: 4.5, ease: "sine.inOut" }, 0);
          tl.fromTo(q(".pre"), { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: .45, ease: "power3.out" }, .25);
          tl.fromTo(q(".big"), { scale: 1.35, opacity: 0, transformOrigin: "0% 60%" }, { scale: 1, opacity: 1, duration: .55, ease: "power4.out" }, .4);
          tl.fromTo(q(".sub"), { clipPath: "inset(0 100% 0 0)", x: -30 }, { clipPath: "inset(0 0% 0 0)", x: 0, duration: .6, ease: "expo.out" }, .8);
          tl.fromTo(q(".lt b"), { xPercent: -105 }, { xPercent: 0, duration: .45, ease: "power3.out" }, 1.5);
          tl.fromTo(q(".lt span"), { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: .55, ease: "power2.out" }, 1.75);
          tl.fromTo(q(".big"), { x: 0 }, { x: 24, duration: 3.4, ease: "none" }, 1.0);
""",
)

# S2: fixture card, start, end, 14 days.
scenes["s2"] = (
    """
#s2-root .chip{left:120px;top:170px}
#s2-root .h1{left:120px;top:250px;font-size:84px}
#s2-root .card{position:absolute;left:120px;top:430px;width:1680px;height:430px;background:#F6F4EE;color:#0C1410;display:grid;grid-template-columns:1fr 330px 1fr;align-items:center}
#s2-root .col{padding:0 70px}
#s2-root .col.r{text-align:right}
#s2-root .lab{font:800 26px/1 "JetBrains Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#4D5E55}
#s2-root .date{margin-top:22px;font:800 76px/1 "Bricolage",sans-serif;letter-spacing:-.03em}
#s2-root .time{margin-top:16px;font:700 40px/1 "JetBrains Mono",monospace}
#s2-root .mid{display:flex;justify-content:center}
#s2-root .disc{width:250px;height:250px;border-radius:50%;background:#FACC15;display:flex;flex-direction:column;align-items:center;justify-content:center;border:8px solid #0C1410}
#s2-root .disc b{font:800 120px/0.9 "Bricolage",sans-serif;letter-spacing:-.04em}
#s2-root .disc span{font:800 28px/1 "JetBrains Mono",monospace;letter-spacing:.18em}
#s2-root .strip{position:absolute;left:120px;top:860px;width:1680px;height:16px;background:#FACC15}
""",
    """
        <div class="chip"><i></i>Schedule</div>
        <div class="h1">$100 trading competition</div>
        <div class="card">
          <div class="col"><div class="lab">Starts</div><div class="date">24 October 2026</div><div class="time">12:00 UTC</div></div>
          <div class="mid"><div class="disc"><b>14</b><span>DAYS</span></div></div>
          <div class="col r"><div class="lab">Ends</div><div class="date">7 November 2026</div><div class="time">12:00 UTC</div></div>
        </div>
        <div class="strip"></div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power3.out" }, .4);
          tl.fromTo(q(".card"), { y: 120, opacity: 0 }, { y: 0, opacity: 1, duration: .6, ease: "expo.out" }, .6);
          tl.fromTo(q(".strip"), { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: .7, ease: "power2.inOut" }, .8);
          tl.fromTo(q(".col:first-child"), { x: -50, opacity: 0 }, { x: 0, opacity: 1, duration: .5, ease: "power3.out" }, 1.0);
          tl.fromTo(q(".disc"), { scale: .2, rotation: -90, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: .7, ease: "back.out(1.6)" }, 1.4);
          tl.fromTo(q(".col.r"), { x: 50, opacity: 0 }, { x: 0, opacity: 1, duration: .5, ease: "power3.out" }, 1.9);
          tl.fromTo(q(".disc"), { rotation: 0 }, { rotation: 8, duration: 2.5, ease: "sine.inOut" }, 2.4);
""",
)

SHIRT = ('<svg class="shirt" viewBox="0 0 200 190"><circle cx="100" cy="95" r="88" fill="{f}" stroke="#0C1410" stroke-width="8"/>'
         '<circle cx="100" cy="74" r="30" fill="#0C1410"/><path d="M46 160 Q100 96 154 160" fill="#0C1410"/></svg>')

# S3: team sheet, how to enter.
scenes["s3"] = (
    """
#s3-root .chip{left:120px;top:170px}
#s3-root .h1{left:120px;top:250px;font-size:120px}
#s3-root .body{left:120px;top:400px;width:820px;font-size:36px}
#s3-root .xi{position:absolute;left:1020px;top:180px;width:780px;height:470px;border:4px solid rgba(246,244,238,.35)}
#s3-root .xi-lab{position:absolute;left:24px;top:20px;font-size:24px;color:#A9C4B4}
#s3-root .p{position:absolute;top:120px;width:200px;text-align:center}
#s3-root .p .shirt{display:block;width:170px;height:162px;margin:0 auto}
#s3-root .p b{display:block;margin-top:14px;font:800 30px/1 "JetBrains Mono",monospace;letter-spacing:.12em}
#s3-root .p1{left:40px}#s3-root .p2{left:290px}#s3-root .p3{left:540px}
#s3-root .tick{position:absolute;top:96px;width:56px;height:56px;border-radius:50%;background:#FACC15;color:#0C1410;display:flex;align-items:center;justify-content:center;font:800 34px/1 "Inter",sans-serif;border:4px solid #0C1410}
#s3-root .t2{left:450px}#s3-root .t3{left:700px}
#s3-root .card{position:absolute;left:120px;top:705px;width:1680px;padding:34px 44px;background:#F6F4EE;color:#0C1410;font:500 36px/1.3 "Inter",sans-serif}
#s3-root .card b{display:block;margin-top:12px;font:800 40px/1.1 "Bricolage",sans-serif}
""",
    f"""
        <div class="chip"><i></i>How to enter</div>
        <div class="h1">Invite 2 friends</div>
        <div class="body">with your invite link or code, found on the Me page. The link and the code are the same invite.</div>
        <div class="xi">
          <div class="xi-lab mono">Your invites</div>
          <div class="p p1">{SHIRT.format(f=ACCENT)}<b>You</b></div>
          <div class="p p2">{SHIRT.format(f=PAPER)}<b>Friend 1</b></div>
          <div class="p p3">{SHIRT.format(f=PAPER)}<b>Friend 2</b></div>
          <div class="tick t2">&#10003;</div><div class="tick t3">&#10003;</div>
        </div>
        <div class="card">A friend counts once they create a Mako Market account through your link (or add your code on their Me page) and place a bet.<b>Both must happen during the competition.</b></div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power4.out" }, .4);
          tl.fromTo(q(".body"), { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power2.out" }, .8);
          tl.fromTo(q(".xi"), { clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0% 0)", duration: .6, ease: "power3.inOut" }, .6);
          tl.fromTo(q(".xi-lab"), { opacity: 0 }, { opacity: 1, duration: .3 }, 1.0);
          tl.fromTo(q(".p1"), { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "back.out(1.4)" }, 1.1);
          tl.fromTo(q(".p2"), { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "back.out(1.4)" }, 1.35);
          tl.fromTo(q(".p3"), { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "back.out(1.4)" }, 1.6);
          tl.fromTo(q(".card"), { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: .55, ease: "expo.out" }, 2.6);
          tl.fromTo(q(".t2"), { scale: 0 }, { scale: 1, duration: .4, ease: "back.out(2)" }, 3.6);
          tl.fromTo(q(".t3"), { scale: 0 }, { scale: 1, duration: .4, ease: "back.out(2)" }, 3.85);
          tl.fromTo(q(".p1 .shirt"), { y: 0 }, { y: -8, duration: .9, ease: "sine.inOut", yoyo: true, repeat: 5 }, 2.0);
""",
)

# S4: entry rules as two referee cards.
scenes["s4"] = (
    """
#s4-root .chip{left:120px;top:170px}
#s4-root .h1{left:120px;top:250px;font-size:96px}
#s4-root .rule{position:absolute;left:120px;width:1680px;min-height:190px;padding:40px 60px 40px 190px;background:#F6F4EE;color:#0C1410;font:600 46px/1.2 "Inter",sans-serif;display:flex;align-items:center}
#s4-root .r1{top:420px}#s4-root .r2{top:650px}
#s4-root .card{position:absolute;left:50px;top:50%;width:96px;height:96px;margin-top:-48px;background:#FACC15;border:4px solid #0C1410;border-radius:50%;display:flex;align-items:center;justify-content:center;font:800 52px/1 "Bricolage",sans-serif;color:#0C1410}
""",
    """
        <div class="chip"><i></i>Entry rules</div>
        <div class="h1">Invite codes</div>
        <div class="rule r1"><div class="card">1</div>Only accounts created after the competition starts can add an inviter's code.</div>
        <div class="rule r2"><div class="card">2</div>You can't use your own code, and an account can only have one inviter.</div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power3.out" }, .4);
          tl.fromTo(q(".r1"), { x: 1800 }, { x: 0, duration: .6, ease: "expo.out" }, .7);
          tl.fromTo(q(".r1 .card"), { scale: 0, rotation: -90 }, { scale: 1, rotation: 0, duration: .5, ease: "back.out(2)" }, 1.15);
          tl.fromTo(q(".r2"), { x: 1800 }, { x: 0, duration: .6, ease: "expo.out" }, 2.1);
          tl.fromTo(q(".r2 .card"), { scale: 0, rotation: 90 }, { scale: 1, rotation: 0, duration: .5, ease: "back.out(2)" }, 2.55);
""",
)

# S5: how players are ranked, the profit formula.
scenes["s5"] = (
    """
#s5-root .chip{left:120px;top:170px}
#s5-root .h1{left:120px;top:250px;font-size:96px}
#s5-root .by{position:absolute;left:120px;top:380px;font:800 64px/1 "Bricolage",sans-serif;letter-spacing:-.02em;color:#FACC15}
#s5-root .row{position:absolute;left:120px;top:510px;width:1680px;display:flex;align-items:center;gap:36px}
#s5-root .blk{flex:1;height:200px;background:#F6F4EE;color:#0C1410;display:flex;flex-direction:column;justify-content:center;padding:0 44px}
#s5-root .blk span{font:800 24px/1 "JetBrains Mono",monospace;letter-spacing:.14em;color:#4D5E55}
#s5-root .blk b{font:800 56px/1.05 "Bricolage",sans-serif;letter-spacing:-.02em}
#s5-root .op{width:170px;height:170px;border-radius:50%;background:#0C1410;color:#FACC15;display:flex;align-items:center;justify-content:center;font:800 34px/1 "JetBrains Mono",monospace;letter-spacing:.1em;flex:none}
#s5-root .cap{position:absolute;left:120px;top:780px;font:600 40px/1.2 "Inter",sans-serif}
""",
    """
        <div class="chip"><i></i>Leaderboard</div>
        <div class="h1">How players are ranked</div>
        <div class="by">By profit during the competition</div>
        <div class="row">
          <div class="blk b1"><b>Winnings and refunds claimed</b></div>
          <div class="op">MINUS</div>
          <div class="blk b2"><b>Stakes placed</b></div>
        </div>
        <div class="cap">Both between the start and end times.</div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power3.out" }, .4);
          tl.fromTo(q(".by"), { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: .7, ease: "power2.out" }, .9);
          tl.fromTo(q(".b1"), { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: .55, ease: "expo.out" }, 1.6);
          tl.fromTo(q(".op"), { scale: 0, rotation: -120 }, { scale: 1, rotation: 0, duration: .55, ease: "back.out(1.7)" }, 2.0);
          tl.fromTo(q(".b2"), { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: .55, ease: "expo.out" }, 2.3);
          tl.fromTo(q(".cap"), { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power2.out" }, 3.0);
""",
)

# S6: the small print, league-table rows.
ROWS = [
    "Only pools you <b>first bet on after the start</b> count.",
    "<b>Claim your winnings before the end.</b> Unclaimed winnings do not count.",
    "You need <b>at least 5 settled pools</b> to be ranked. Refunded pools do not count.",
    "Ties go to the <b>higher win rate</b>: settled pools won out of settled pools played.",
]
scenes["s6"] = (
    """
#s6-root .chip{left:120px;top:170px}
#s6-root .h1{left:120px;top:250px;font-size:96px}
#s6-root .tbl{position:absolute;left:120px;top:390px;width:1680px}
#s6-root .tr{display:flex;align-items:center;min-height:130px;margin-bottom:12px;background:rgba(8,10,14,.78);border-left:10px solid #FACC15}
#s6-root .tr:nth-child(even){background:rgba(8,10,14,.66)}
#s6-root .n{flex:none;width:120px;font:800 64px/1 "Bricolage",sans-serif;color:#FACC15;text-align:center}
#s6-root .t{padding:22px 40px 22px 10px;font:500 38px/1.25 "Inter",sans-serif}
#s6-root .t b{font-weight:800;color:#FACC15}
""",
    """
        <div class="chip"><i></i>The small print</div>
        <div class="h1">What counts</div>
        <div class="tbl">
""" + "\n".join(f'          <div class="tr r{i+1}"><div class="n">{i+1}</div><div class="t">{t}</div></div>' for i, t in enumerate(ROWS)) + """
        </div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power3.out" }, .4);
          [1, 2, 3, 4].forEach(function (n, i) {
            tl.fromTo(q(".r" + n), { x: 260, opacity: 0 }, { x: 0, opacity: 1, duration: .5, ease: "power3.out" }, .8 + i * 1.25);
            tl.fromTo(q(".r" + n + " .n"), { scale: 1.8 }, { scale: 1, duration: .45, ease: "back.out(2)" }, .95 + i * 1.25);
          });
""",
)

# S7: prizes podium, count-up, then the VAR check.
scenes["s7"] = (
    """
#s7-root .chip{left:120px;top:170px}
#s7-root .h1{left:120px;top:250px;font-size:96px}
#s7-root .paid{position:absolute;right:120px;top:270px;font:600 38px/1.2 "Inter",sans-serif;text-align:right}
#s7-root .pod{position:absolute;bottom:264px;width:440px;display:flex;flex-direction:column;justify-content:flex-start;align-items:center;padding-top:30px;color:#0C1410}
#s7-root .pod b{font:800 120px/1 "Bricolage",sans-serif;letter-spacing:-.04em}
#s7-root .pod span{margin-top:6px;font:800 30px/1 "JetBrains Mono",monospace;letter-spacing:.16em;text-transform:uppercase}
#s7-root .p1{left:740px;height:410px;background:#FACC15}
#s7-root .p2{left:270px;height:320px;background:#F6F4EE}
#s7-root .p3{left:1210px;height:250px;background:#F6F4EE}
#s7-root .var{position:absolute;left:120px;top:836px;width:1680px;height:120px;background:#0C1410;display:flex;align-items:center;border-top:6px solid #FACC15}
#s7-root .var .tag{flex:none;height:100%;display:flex;align-items:center;padding:0 34px;background:#FACC15;color:#0C1410;font:800 34px/1 "JetBrains Mono",monospace;letter-spacing:.12em}
#s7-root .var .msg{padding:0 34px;font:500 34px/1.25 "Inter",sans-serif}
""",
    """
        <div class="chip"><i></i>Prizes</div>
        <div class="h1">The top 3 share <span class="y">$100</span></div>
        <div class="paid">Paid after the competition ends.</div>
        <div class="pod p2"><b data-v="30">$30</b><span>2nd</span></div>
        <div class="pod p1"><b data-v="50">$50</b><span>1st</span></div>
        <div class="pod p3"><b data-v="20">$20</b><span>3rd</span></div>
        <div class="var"><div class="tag">UNDER REVIEW</div><div class="msg">Mako Market reviews the winners first and may disqualify duplicate or fake accounts.</div></div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".h1"), { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: .5, ease: "power3.out" }, .4);
          [[".p3", 1.0], [".p2", 1.3], [".p1", 1.6]].forEach(function (p) {
            tl.fromTo(q(p[0]), { scaleY: 0, transformOrigin: "50% 100%" }, { scaleY: 1, duration: .6, ease: "expo.out" }, p[1]);
            var el = document.querySelector(R + p[0] + " b");
            var v = +el.getAttribute("data-v"), o = { n: 0 };
            tl.fromTo(o, { n: 0 }, { n: v, duration: .9, ease: "power2.out", onUpdate: function () { el.textContent = "$" + Math.round(o.n); } }, p[1] + .2);
          });
          tl.fromTo(q(".paid"), { x: 40, opacity: 0 }, { x: 0, opacity: 1, duration: .5, ease: "power3.out" }, 2.6);
          tl.fromTo(q(".var"), { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: .55, ease: "expo.out" }, 3.6);
          tl.fromTo(q(".var .msg"), { opacity: 0 }, { opacity: 1, duration: .4 }, 3.9);
""",
)

# S8: live standings and the lockup.
scenes["s8"] = (
    """
#s8-root .chip{left:120px;top:170px}
#s8-root .url{position:absolute;left:120px;top:262px;width:1680px;white-space:nowrap;font:800 80px/1.05 "Bricolage",sans-serif;letter-spacing:-.03em}
#s8-root .upd{position:absolute;left:120px;top:470px;font:600 40px/1.2 "Inter",sans-serif;color:#A9C4B4}
#s8-root .ko{position:absolute;left:120px;top:560px;display:flex;height:84px}
#s8-root .ko b{display:flex;align-items:center;padding:0 28px;background:#FACC15;color:#0C1410;font:800 30px/1 "JetBrains Mono",monospace;letter-spacing:.12em}
#s8-root .ko span{display:flex;align-items:center;padding:0 30px;background:#F6F4EE;color:#0C1410;font:800 40px/1 "Bricolage",sans-serif}
#s8-root .lock{position:absolute;left:120px;top:720px;display:flex;align-items:center;gap:26px}
#s8-root .mk{width:120px;height:94px;color:#F6F4EE}
#s8-root .lock .nm{font:800 76px/1 "Bricolage",sans-serif;letter-spacing:-.03em}
#s8-root .lock .pill{margin-left:20px;padding:20px 38px;border-radius:999px;background:#FACC15;color:#0C1410;font:800 44px/1 "Bricolage",sans-serif}
""",
    f"""
        <div class="chip"><i></i>Live standings</div>
        <div class="url"><span class="y">makomarket.xyz</span>/leaderboard/competition</div>
        <div class="upd">Updates about every 30 minutes.</div>
        <div class="ko"><b>STARTS</b><span>24 October 2026, 12:00 UTC</span></div>
        <div class="lock">{logo("mk")}<div class="nm">Mako Market</div><div class="pill">makomarket.xyz</div></div>
""",
    """
          tl.fromTo(q(".chip"), { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: .4, ease: "power3.out" }, .3);
          tl.fromTo(q(".url"), { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: .8, ease: "power2.inOut" }, .45);
          tl.fromTo(q(".upd"), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: .45, ease: "power2.out" }, 1.2);
          tl.fromTo(q(".ko"), { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: .5, ease: "expo.out" }, 1.7);
          tl.fromTo(q(".mk"), { scale: 0, rotation: -40 }, { scale: 1, rotation: 0, duration: .6, ease: "back.out(1.8)" }, 2.4);
          tl.fromTo(q(".nm"), { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: .45, ease: "power3.out" }, 2.6);
          tl.fromTo(q(".pill"), { scale: .6, opacity: 0 }, { scale: 1, opacity: 1, duration: .5, ease: "back.out(1.6)" }, 2.9);
""",
)

for sid, start, end in SCENES:
    css, html, js = scenes[sid]
    (ROOT / "compositions" / f"{sid}.html").write_text(scene_file(sid, round(end - start, 3), css, html, js))


# ---------- arena backgrounds: one per market category ----------
import math, random

def svg_wrap(body, cls=""):
    return f'<svg class="arena-svg {cls}" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">{body}</svg>'

def arena_football():
    b = '<rect width="1920" height="1080" fill="#0D3B2A"/>'
    b += "".join(f'<rect x="{x}" y="0" width="190" height="1080" fill="#0B3324"/>' for x in range(190, 1920, 380))
    b += '<rect x="1437" y="0" width="6" height="1080" fill="rgba(246,244,238,.18)"/>'
    b += '<circle cx="1440" cy="540" r="300" fill="none" stroke="rgba(246,244,238,.18)" stroke-width="6"/>'
    b += '<circle cx="1440" cy="540" r="14" fill="rgba(246,244,238,.22)"/>'
    return svg_wrap(b)

def arena_nba():
    b = '<rect width="1920" height="1080" fill="#7A4521"/>'
    b += "".join(f'<rect x="0" y="{y}" width="1920" height="36" fill="{"#83502A" if (y // 36) % 2 else "#744020"}"/>' for y in range(0, 1080, 36))
    b += '<rect x="1580" y="350" width="340" height="380" fill="rgba(234,88,12,.35)" stroke="rgba(246,244,238,.3)" stroke-width="6"/>'
    b += '<circle cx="1920" cy="540" r="640" fill="none" stroke="rgba(246,244,238,.25)" stroke-width="6"/>'
    b += '<circle cx="1580" cy="540" r="140" fill="none" stroke="rgba(246,244,238,.25)" stroke-width="6"/>'
    b += '<rect x="1060" y="0" width="6" height="1080" fill="rgba(246,244,238,.25)"/>'
    b += '<circle cx="1063" cy="540" r="170" fill="none" stroke="rgba(246,244,238,.25)" stroke-width="6"/>'
    b += '<rect width="1920" height="1080" fill="rgba(10,8,6,.5)"/>'
    return svg_wrap(b)

def arena_crypto():
    rnd = random.Random(11)
    b = '<rect width="1920" height="1080" fill="#0A1424"/>'
    b += "".join(f'<rect x="{x}" y="0" width="2" height="1080" fill="rgba(246,244,238,.06)"/>' for x in range(0, 1920, 120))
    b += "".join(f'<rect x="0" y="{y}" width="1920" height="2" fill="rgba(246,244,238,.06)"/>' for y in range(0, 1080, 120))
    price, c = 620, []
    for i in range(46):
        o = price; price += rnd.uniform(-38, 44); cl = price
        hi, lo = max(o, cl) + rnd.uniform(6, 30), min(o, cl) - rnd.uniform(6, 30)
        x = 60 + i * 44; up = cl < o  # y grows downward, so a smaller y is a higher price
        col = "#16A34A" if up else "#E53935"
        c.append(f'<rect x="{x+13}" y="{lo:.0f}" width="4" height="{hi-lo:.0f}" fill="{col}" opacity=".5"/>')
        c.append(f'<rect x="{x}" y="{min(o,cl):.0f}" width="30" height="{max(abs(cl-o),6):.0f}" fill="{col}" opacity=".55"/>')
    b += f'<g class="candles">{"".join(c)}</g>'
    return svg_wrap(b)

def arena_politics():
    b = '<rect width="1920" height="1080" fill="#111833"/>'
    cols = ["#3B82F6", "#3B82F6", "#E53935", "#E53935", "#A3A3A3", "#FACC15"]
    seats = []
    for row in range(9):
        r = 230 + row * 44; n = int(math.pi * r / 40)
        for k in range(n + 1):
            a = math.pi - math.pi * k / n
            x, y = 1440 + r * math.cos(a), 900 - r * math.sin(a)
            col = cols[min(5, int(6 * k / (n + 1)))]
            seats.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="13" fill="{col}" opacity=".42"/>')
    b += f'<g class="seats">{"".join(seats)}</g>'
    b += '<rect x="1340" y="860" width="200" height="120" rx="8" fill="rgba(246,244,238,.12)"/>'
    return svg_wrap(b)

ARENAS = {"football": arena_football, "nba": arena_nba, "crypto": arena_crypto, "politics": arena_politics}
ARENA_LABEL = {"football": "FOOTBALL", "nba": "NBA", "crypto": "CRYPTO", "politics": "POLITICS"}
WALL = ["football", "nba", "crypto", "politics"]
SCENE_ARENA = {"s1": "wall", "s2": "crypto", "s3": "nba", "s4": "politics", "s5": "football", "s6": "crypto", "s7": "nba", "s8": "wall"}

def arena_layer(sid, kind, s, e):
    if kind == "wall":
        cells = "".join(f'<div class="cell c{i}">{ARENAS[k]()}<div class="cell-lab">{ARENA_LABEL[k]}</div></div>' for i, k in enumerate(WALL))
        inner = f'<div class="wall">{cells}</div>'
    else:
        inner = ARENAS[kind]()
    return (f'    <div id="bg-{sid}" class="clip bg bg-{kind}" data-start="{s}" data-duration="{round(e - s, 3)}" data-track-index="0">'
            f'{inner}<div class="shade"></div></div>')

bgs = "\n".join(arena_layer(sid, SCENE_ARENA[sid], s, e) for sid, s, e in SCENES)
bg_js = "\n".join(
    f'      tl.fromTo("#bg-{sid} .arena-svg", {{ scale: 1.0 }}, {{ scale: 1.06, duration: {round(e - s, 3)}, ease: "none" }}, {s});'
    if SCENE_ARENA[sid] != "wall" else
    f'      tl.fromTo("#bg-{sid} .cell", {{ scale: .9, opacity: 0 }}, {{ scale: 1, opacity: 1, duration: .5, ease: "power3.out", stagger: .12 }}, {s + (0.05 if s == 0 else 0.3)});'
    for sid, s, e in SCENES)
CAT_SEQ = ["ALL MARKETS" if SCENE_ARENA[sid] == "wall" else ARENA_LABEL[SCENE_ARENA[sid]] for sid, _, _ in SCENES]
cat_html = "".join(f"<b>{c}</b>" for c in CAT_SEQ)
cat_js = "\n".join(f'      tl.fromTo("#bug .cat-in b:nth-child({i+1})", {{ opacity: 0, y: 30 }}, {{ opacity: 1, y: 0, duration: .25, ease: "power2.out", immediateRender: false }}, {max(s, .9)});'
                   + (f'\n      tl.fromTo("#bug .cat-in b:nth-child({i+1})", {{ opacity: 1 }}, {{ opacity: 0, duration: .01, immediateRender: false }}, {e});' if i < len(SCENES) - 1 else "")
                   for i, (sid, s, e) in enumerate(SCENES))

# ---------- index.html: the persistent broadcast layer ----------
TICK_ITEMS = [
    "$100 trading competition",
    "Football", "NBA", "Crypto", "Politics",
    "24 October 2026, 12:00 UTC to 7 November 2026, 12:00 UTC",
    "The top 3 share $100",
    "Live standings: makomarket.xyz/leaderboard/competition",
]
tick_html = "".join(f"<span>{t}</span><i></i>" for t in TICK_ITEMS * 3)

hosts = "\n".join(
    f'    <div id="el-{sid}" class="clip shot" data-composition-id="{sid}" data-composition-src="compositions/{sid}.html" '
    f'data-start="{s}" data-duration="{round(e - s, 3)}" data-track-index="1" data-width="{W}" data-height="{H}"></div>'
    for sid, s, e in SCENES
)
cuts = [s for _, s, _ in SCENES[1:]]
stingers = "\n".join(
    f'    <div id="stg{i}" class="clip stg" data-start="{round(c - .45, 3)}" data-duration="0.9" data-track-index="3">'
    f'<div class="band"><div class="edge"></div>{logo("stg-logo", INK)}</div></div>'
    for i, c in enumerate(cuts)
)
stinger_js = "\n".join(
    f'      tl.fromTo("#stg{i} .band", {{ x: -2700 }}, {{ x: 2500, duration: .9, ease: "power2.inOut" }}, {round(c - .45, 3)});'
    for i, c in enumerate(cuts)
)

index = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={W}, height={H}" />
    <title>Mako Market $100 trading competition</title>
    <!-- Generated by build/gen.py. Edit that file, then rebuild. Facts: claims.md. -->
    <script src="assets/gsap.min.js"></script>
    <style>{FONTS}
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ width: 100%; height: 100%; overflow: hidden; background: {INK}; }}
      #root {{ position: relative; width: 100%; height: 100%; overflow: hidden; background: {INK}; font-family: "Inter", sans-serif; }}
      #root > .shot {{ position: absolute; inset: 0; z-index: 10; }}
      .bg {{ position: absolute; inset: 0; z-index: 0; overflow: hidden; }}
      .arena-svg {{ position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; }}
      .bg .shade {{ position: absolute; inset: 0; background: radial-gradient(ellipse at 30% 45%, rgba(6,9,12,.5) 0%, rgba(6,9,12,.25) 60%, rgba(6,9,12,.6) 100%); }}
      .wall {{ position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 8px; background: {INK}; }}
      .cell {{ position: relative; overflow: hidden; }}
      .cell .arena-svg {{ width: 100%; height: 100%; }}
      .c0 .cell-lab, .c1 .cell-lab {{ top: 130px; }}
      .c2 .cell-lab {{ bottom: 100px; }}
      .c3 .cell-lab {{ top: 24px; }}
      .cell-lab {{ position: absolute; right: 24px; padding: 10px 16px; background: rgba(8,10,14,.82); color: {PAPER}; font: 800 24px/1 "JetBrains Mono", monospace; letter-spacing: .14em; }}
      .bg-wall .shade {{ background: rgba(6,9,12,.42); }}
      #bug {{ position: absolute; left: 60px; top: 46px; z-index: 40; display: flex; height: 64px; }}
      #bug .lg {{ width: 84px; background: {ACCENT}; display: flex; align-items: center; justify-content: center; }}
      #bug .lg svg {{ width: 50px; height: 40px; }}
      #bug .nm {{ display: flex; align-items: center; padding: 0 22px; background: {INK}; color: {PAPER}; font: 800 30px/1 "Bricolage", sans-serif; letter-spacing: -.01em; }}
      #bug .cp {{ display: flex; align-items: center; padding: 0 22px; background: {PAPER}; color: {INK}; font: 800 24px/1 "JetBrains Mono", monospace; letter-spacing: .12em; }}
      #bug .cat {{ position: relative; height: 64px; width: 230px; overflow: hidden; background: {ACCENT}; }}
      #bug .cat-in {{ position: absolute; inset: 0; }}
      #bug .cat-in b {{ position: absolute; inset: 0; opacity: 0; display: flex; align-items: center; justify-content: center; height: 64px; color: {INK}; font: 800 24px/1 "JetBrains Mono", monospace; letter-spacing: .12em; }}
      #net {{ position: absolute; right: 60px; top: 46px; z-index: 40; height: 64px; display: flex; align-items: center; padding: 0 22px; border: 3px solid rgba(246,244,238,.6); color: {PAPER}; font: 700 24px/1 "JetBrains Mono", monospace; letter-spacing: .12em; }}
      #tick {{ position: absolute; left: 0; bottom: 0; width: 1920px; height: 72px; z-index: 40; background: {INK}; border-top: 4px solid {ACCENT}; overflow: hidden; }}
      #tick .crawl {{ position: absolute; left: 0; top: 0; height: 100%; display: flex; align-items: center; white-space: nowrap; color: {PAPER}; font: 700 26px/1 "JetBrains Mono", monospace; letter-spacing: .08em; text-transform: uppercase; }}
      #tick .crawl span {{ padding: 0 34px; }}
      #tick .crawl i {{ display: block; width: 14px; height: 14px; background: {ACCENT}; flex: none; }}
      #tab {{ position: absolute; right: 60px; bottom: 72px; z-index: 41; height: 44px; display: flex; align-items: center; padding: 0 22px; background: {ACCENT}; color: {INK}; font: 800 24px/1 "JetBrains Mono", monospace; letter-spacing: .14em; }}
      .stg {{ position: absolute; inset: 0; z-index: 60; overflow: hidden; }}
      .stg .band {{ position: absolute; left: 0; top: -60px; width: 2600px; height: 1200px; background: {ACCENT}; transform: skewX(-14deg); display: flex; align-items: center; justify-content: center; }}
      .stg .edge {{ position: absolute; right: -70px; top: 0; width: 70px; height: 100%; background: {PAPER}; }}
      .stg .stg-logo {{ width: 260px; height: 205px; transform: skewX(14deg); }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{TOTAL}" data-width="{W}" data-height="{H}">
{bgs}
{hosts}
    <div id="bug" class="clip" data-start="0.6" data-duration="{round(TOTAL - .6, 3)}" data-track-index="2"><div class="lg">{logo("bug-logo", INK)}</div><div class="nm">Mako Market</div><div class="cp">$100 COMP</div><div class="cat"><div class="cat-in">{cat_html}</div></div></div>
    <div id="net" class="clip" data-start="0.6" data-duration="{round(TOTAL - .6, 3)}" data-track-index="2">MONAD TESTNET</div>
    <div id="tick" class="clip" data-start="4.5" data-duration="{round(TOTAL - 4.5, 3)}" data-track-index="2"><div class="crawl" data-layout-allow-overflow>{tick_html}</div></div>
    <div id="tab" class="clip" data-start="4.5" data-duration="{round(TOTAL - 4.5, 3)}" data-track-index="2">MAKO MARKET</div>
{stingers}
    </div>
    <script>
      var tl = gsap.timeline({{ paused: true }});
{bg_js}
{cat_js}
      tl.fromTo("#bug", {{ x: -500 }}, {{ x: 0, duration: .6, ease: "expo.out" }}, .6);
      tl.fromTo("#net", {{ x: 500 }}, {{ x: 0, duration: .6, ease: "expo.out" }}, .75);
      tl.fromTo("#tick", {{ y: 80 }}, {{ y: 0, duration: .5, ease: "power3.out" }}, 4.5);
      tl.fromTo("#tab", {{ y: 130 }}, {{ y: 0, duration: .5, ease: "power3.out" }}, 4.7);
      tl.fromTo("#tick .crawl", {{ x: 0 }}, {{ x: -4200, duration: {round(TOTAL - 4.5, 3)}, ease: "none" }}, 4.5);
{stinger_js}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""
(ROOT / "index.html").write_text(index)
print("wrote index.html and", len(SCENES), "scenes; total", TOTAL, "s")
