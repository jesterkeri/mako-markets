// Generates compositions/sNN.html from src/sNN.js (+ optional src/sNN.html markup) with the shared EXPL chrome.
// Usage: node src/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.dirname(here);

const SHOTS = {
  s14: { dur: 1.5, tl: "<b>Fig. 01</b>&nbsp;&nbsp;Sign-in card&nbsp;&nbsp;/&nbsp;&nbsp;Exploded view", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Sign in", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Plan" },
  s18: { dur: 2.0, tl: "<b>Fig. 02</b>&nbsp;&nbsp;Pool card&nbsp;&nbsp;/&nbsp;&nbsp;Exploded view", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Bet panel", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Iso right" },
  s19: { dur: 2.5, tl: "<b>Fig. 03</b>&nbsp;&nbsp;Pool card&nbsp;&nbsp;/&nbsp;&nbsp;Toggle layer", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Bet panel", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Iso left" },
  s21: { dur: 1.5, tl: "<b>Fig. 04</b>&nbsp;&nbsp;Pool card&nbsp;&nbsp;/&nbsp;&nbsp;Amount layer", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Bet panel", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Low iso" },
  s25: { dur: 1.5, tl: "<b>Pool</b>&nbsp;&nbsp;/&nbsp;&nbsp;Section view", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Payout", br: "Not to scale" },
  s29: { dur: 2.0, tl: "<b>Fig. 05</b>&nbsp;&nbsp;Create pool&nbsp;&nbsp;/&nbsp;&nbsp;Fan view", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Host", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Plan oblique" },
  s35: { dur: 1.5, tl: "<b>Fig. 06</b>&nbsp;&nbsp;Leaderboard&nbsp;&nbsp;/&nbsp;&nbsp;Exploded view", tr: "Mako Market&nbsp;&nbsp;/&nbsp;&nbsp;Rankings", br: "View&nbsp;&nbsp;/&nbsp;&nbsp;Iso left" },
};

const FONTS = `
@font-face{font-family:"Bricolage Grotesque Variable";font-style:normal;font-display:block;font-weight:200 800;src:url("assets/fonts/captured-bricolage-grotesque-latin-ext-wght-normal.0-cv.c7uda8um.woff2") format("woff2-variations");unicode-range:U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Bricolage Grotesque Variable";font-style:normal;font-display:block;font-weight:200 800;src:url("assets/fonts/captured-bricolage-grotesque-latin-wght-normal.0hh3pksc_dt39.woff2") format("woff2-variations");unicode-range:U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Inter Variable";font-style:normal;font-display:block;font-weight:100 900;src:url("assets/fonts/captured-font-05ec79683006ecd1.woff2") format("woff2-variations");unicode-range:U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Inter Variable";font-style:normal;font-display:block;font-weight:100 900;src:url("assets/fonts/captured-inter-latin-wght-normal.055ydel_y7o6i.woff2") format("woff2-variations");unicode-range:U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-display:block;font-weight:100 800;src:url("assets/fonts/jbmono-latin.woff2") format("woff2");}`;

const css = (id) => `${FONTS}
#${id}-root{position:absolute;inset:0;overflow:hidden;background:#EBE5D9;color:#000;font-family:"Inter Variable",sans-serif}
#${id}-root .xp-grid{position:absolute;inset:0;background-image:linear-gradient(rgba(0,0,0,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.055) 1px,transparent 1px);background-size:48px 48px;background-position:-1px -1px}
#${id}-root .xp-vig{position:absolute;inset:0;background:radial-gradient(70% 70% at 55% 50%,rgba(235,229,217,0) 40%,rgba(214,207,190,.75) 100%)}
#${id}-root .xp-canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
#${id}-root .xp-tag{position:absolute;font:600 15px "JetBrains Mono",monospace;letter-spacing:.2em;text-transform:uppercase;color:#5f594c;white-space:nowrap}
#${id}-root .xp-tag b{color:#000;font-weight:700}
#${id}-root .xp-tl{left:96px;top:80px}
#${id}-root .xp-tr{right:96px;top:80px}
#${id}-root .xp-bl{left:96px;bottom:72px;color:#000}
#${id}-root .xp-br{right:96px;bottom:72px}
#${id}-root .xp-cross{position:absolute;width:22px;height:22px}
#${id}-root .xp-cross:before,#${id}-root .xp-cross:after{content:"";position:absolute;background:#000}
#${id}-root .xp-cross:before{left:10px;top:0;width:1.25px;height:22px}
#${id}-root .xp-cross:after{top:10px;left:0;height:1.25px;width:22px}
#${id}-root .xp-rule{position:absolute;left:96px;right:96px;height:1.25px;background:rgba(0,0,0,.5)}
#${id}-root .xp-rule-t{top:118px}
#${id}-root .xp-rule-b{bottom:110px}
#${id}-root .xp-leaders{position:absolute;left:0;top:0;width:1920px;height:1080px;overflow:visible}
#${id}-root .xp-leaders line{stroke:rgba(0,0,0,.55);stroke-width:1.25}
#${id}-root .xp-leaders circle{stroke:#000;stroke-width:1.25}
#${id}-root .xp-labels{position:absolute;left:0;top:0;width:0;height:0}
#${id}-root .xp-label{position:absolute;left:0;top:-15px;display:flex;align-items:center;gap:16px;font:600 22px "JetBrains Mono",monospace;letter-spacing:.16em;text-transform:uppercase;color:#000;white-space:nowrap;opacity:0;line-height:30px}
#${id}-root .xp-left{translate:-100% 0}
#${id}-root .xp-idx{font-weight:700;color:#7a7466}
#${id}-root .xp-case{text-transform:none;letter-spacing:.08em;font-size:26px}
#${id}-root .xp-case .xp-idx{color:#000}
#${id}-root .xp-h{position:absolute;font:800 132px/0.92 "Bricolage Grotesque Variable",sans-serif;letter-spacing:-.035em;color:#000}
#${id}-root .xp-ln{display:block;overflow:hidden;padding-bottom:8px;margin-bottom:-8px}
#${id}-root .xp-ln > span{display:block;white-space:nowrap}
#${id}-root .xp-y{display:inline-block;background:#FACC15;line-height:.86;padding:6px 18px 16px;border-radius:18px;margin-right:6px}
#${id}-root .xp-n{color:#D94A3D}`;

const chrome = (s) => `
        <div class="xp-grid"></div>
        <div class="xp-vig"></div>
        <canvas id="${s.id}-canvas" class="xp-canvas" width="1920" height="1080"></canvas>
        <div class="xp-rule xp-rule-t"></div>
        <div class="xp-rule xp-rule-b"></div>
        <div class="xp-cross" style="left:85px;top:107px"></div>
        <div class="xp-cross" style="right:85px;top:107px"></div>
        <div class="xp-cross" style="left:85px;bottom:99px"></div>
        <div class="xp-cross" style="right:85px;bottom:99px"></div>
        <div class="xp-tag xp-tl">${s.tl}</div>
        <div class="xp-tag xp-tr">${s.tr}</div>
        <div class="xp-tag xp-bl">makomarket.xyz</div>
        <div class="xp-tag xp-br">${s.br}</div>`;

for (const [id, s] of Object.entries(SHOTS)) {
  s.id = id;
  const jsPath = path.join(here, id + ".js");
  if (!fs.existsSync(jsPath)) continue;
  const js = fs.readFileSync(jsPath, "utf8").trim();
  const mkPath = path.join(here, id + ".html");
  const markup = fs.existsSync(mkPath) ? fs.readFileSync(mkPath, "utf8").trim() : "";
  const extraCss = fs.existsSync(path.join(here, id + ".css")) ? fs.readFileSync(path.join(here, id + ".css"), "utf8").trim() : "";
  const html = `<!doctype html>
<!-- Mako Market ad, EXPL (Exploded UI) shot ${id.slice(1)}. Generated by src/build.mjs; edit src/${id}.* and rebuild. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>EXPL ${id}</title>
  </head>
  <body>
    <template>
      <style>${css(id)}
${extraCss}
      </style>
      <div id="${id}-root" data-composition-id="${id}" data-start="0" data-duration="${s.dur}" data-width="1920" data-height="1080">${chrome(s)}
        ${markup}
      </div>
      <script type="module">
        import * as THREE from "./assets/three.module.min.js";
        import * as K from "./assets/expl-kit.js";
        // the mounted root may not keep its authored id, so find it from the canvas
        const ROOT = document.getElementById("${id}-canvas").parentElement;
        const DUR = ${s.dur};
        window.__hf = window.__hf || {};
        window.__hf.buildReady = window.__hf.buildReady || {};
        let ready;
        window.__hf.buildReady["expl-${id}"] = new Promise((r) => (ready = r));
${js}
        try {
          const { tl } = await K.buildShot("${id}", DUR, setup);
          window.__timelines["${id}"] = tl;
        } catch (err) {
          console.error("[expl ${id}]", err && err.stack ? err.stack : err);
        }
        ready();
      </script>
    </template>
  </body>
</html>
`;
  fs.writeFileSync(path.join(proj, "compositions", id + ".html"), html);
  console.log("wrote", id);
}
