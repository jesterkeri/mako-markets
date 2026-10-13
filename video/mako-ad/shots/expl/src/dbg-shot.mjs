// usage: node dbg.mjs <projdir> <shotId> <t1,t2,...> <outprefix>
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
const require = createRequire("/tmp/claude-0/-home-user-mako-markets/71601d9e-4a9c-5638-8755-dce95a1141c6/scratchpad/three-test/node_modules/");
const { chromium } = require("playwright-core");
const [proj, id, times, out] = process.argv.slice(2);
const src = fs.readFileSync(path.join(proj, "compositions", id + ".html"), "utf8");
const inner = src.split("<template>")[1].split("</template>")[0];
const page = `<!doctype html><html><head><meta charset="utf-8"><script src="assets/gsap.min.js"></script>
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:1920px;height:1080px;overflow:hidden;background:#EBE5D9}</style>
<script>window.__timelines={};</script></head><body><div style="position:absolute;inset:0">${inner}</div></body></html>`;
const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".woff2": "font/woff2", ".html": "text/html", ".css": "text/css" };
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/__dbg.html") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page); }
  const f = path.join(proj, u);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" });
  res.end(fs.readFileSync(f));
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell", args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
p.on("console", (m) => console.log("console:", m.type(), m.text()));
p.on("requestfailed", (r) => console.log("reqfail", r.url())); p.on("response", (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); });
p.on("pageerror", (e) => console.log("pageerror:", e.message));
await p.goto(`http://127.0.0.1:${port}/__dbg.html`);
await p.waitForFunction((id) => !!window.__timelines[id], id, { timeout: 20000 }).catch(() => console.log("TIMEOUT waiting timeline"));
console.log(await p.evaluate(() => JSON.stringify({hf: Object.keys((window.__hf||{}).buildReady||{}), fonts: document.fonts.status, faces: [...document.fonts].map(f=>f.family+":"+f.status)})));
for (const t of times.split(",")) {
  await p.evaluate(([id, t]) => { window.__timelines[id].seek(Number(t), false); return 1; }, [id, t]);
  await p.screenshot({ path: `${out}-${t}.png` });
}
await browser.close();
srv.close();
