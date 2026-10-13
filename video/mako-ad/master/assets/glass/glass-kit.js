/*
  Mako Market GLASS kit (shared by every GLASS shot sNN.html).
  Built from the forked registry block `ios26-liquid-glass` (board3/work-1):
  - three r147 + GLTFLoader loaded locally from this folder (CDNs blocked), once per page.
  - ONE shared WebGLRenderer for all GLASS shots (keeps the page at a single WebGL context);
    each shot paints the shared render into its own 2D <canvas> after setting its state.
  - Phone screen painted with the block's 2D-canvas liquid-glass painter (blurred backdrop
    copy + tint + caustic + rim + specular) that replaced drawElementImage.
  - 3D glass slabs (logo lockups, toast, live card): extruded bevelled slab whose shader
    refracts a low-res blurred render of the scene behind it (frosted glass).
  Idempotent: safe to include from several sub-compositions.
*/
(function () {
  if (window.MakoGlass) return;
  var cs = document.currentScript;
  var src = (cs && cs.src) || "";
  if (!/glass-kit\.js/.test(src)) src = "";
  if (!src) {
    var all = document.getElementsByTagName("script");
    for (var i = 0; i < all.length; i++) if (/glass-kit\.js/.test(all[i].src)) src = all[i].src;
  }
  // When the compiler inlines this file there is no src: fall back to the project-root path.
  var base = /glass-kit\.js/.test(src) ? src.slice(0, src.lastIndexOf("/") + 1) : "assets/glass/";
  function load(f) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = base + f;
      s.async = false;
      s.onload = res;
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  var W = 1920, H = 1080, SW = 390, SH = 844, PI = Math.PI;
  var MG = (window.MakoGlass = { W: W, H: H, SW: SW, SH: SH, PI: PI });
  MG.FIN_D =
    "M 25,285 L 80,259 C 80,227 112,177 123,169 L 115,251 L 150,259 C 160,186 246,135 246,135 C 246,135 226,156 211,196 C 196,235 196,259 196,259 L 239,308 C 229,222 306,86 380,5 C 298,40 193,111 160,153 C 160,153 155,132 163,104 C 170,76 184,50 183,47 C 112,81 44,221 25,285 Z";
  MG.BR = '"Bricolage Grotesque Variable", sans-serif';
  MG.IN = '"Inter Variable", sans-serif';
  MG.MO = '"JetBrains Mono", monospace';
  MG.fonts = function () {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load('800 30px "Bricolage Grotesque Variable"'),
      document.fonts.load('600 14px "JetBrains Mono"'),
      document.fonts.load('500 14px "Inter Variable"'),
      document.fonts.load('700 14px "Inter Variable"'),
    ]).catch(function () {});
  };

  // ── eases (block's cubic-bezier set) ──────────────────────────────
  function cbz(p1x, p1y, p2x, p2y) {
    var ax = 3 * p1x - 3 * p2x + 1, bx = 3 * p2x - 6 * p1x, cx = 3 * p1x;
    var ay = 3 * p1y - 3 * p2y + 1, by = 3 * p2y - 6 * p1y, cy = 3 * p1y;
    return function (t) {
      var s = t;
      for (var i = 0; i < 12; i++) {
        var x = ((ax * s + bx) * s + cx) * s - t;
        var dx = (3 * ax * s + 2 * bx) * s + cx;
        if (Math.abs(dx) < 1e-10) break;
        s -= x / dx;
      }
      s = Math.max(0, Math.min(1, s));
      return ((ay * s + by) * s + cy) * s;
    };
  }
  MG.ease = {
    enter: cbz(0.16, 1.0, 0.3, 1.0),
    notify: cbz(0.22, 0.0, 0.16, 1.0),
    drift: cbz(0.45, 0.0, 0.15, 1.0),
    breathe: cbz(0.37, 0.0, 0.63, 1.0),
  };
  MG.clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  MG.drop = function (p) {
    var q = MG.ease.notify(MG.clamp(p, 0, 1));
    return { q: q, dy: (1 - q) * -46 + Math.sin(q * PI) * 5 };
  };
  MG.rise = function (p, dist) {
    var q = MG.ease.enter(MG.clamp(p, 0, 1));
    return { q: q, dy: (1 - q) * (dist || 300) };
  };

  // ── 2D phone-screen painter ───────────────────────────────────────
  function rr(ctx, x, y, w, h, r) {
    var q = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + q, y);
    ctx.lineTo(x + w - q, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + q);
    ctx.lineTo(x + w, y + h - q);
    ctx.quadraticCurveTo(x + w, y + h, x + w - q, y + h);
    ctx.lineTo(x + q, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - q);
    ctx.lineTo(x, y + q);
    ctx.quadraticCurveTo(x, y, x + q, y);
    ctx.closePath();
  }
  MG.rr = rr;
  MG.fin = function (ctx, x, y, size, color) {
    if (!MG._fin) MG._fin = new Path2D(MG.FIN_D);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 400, size / 400);
    ctx.fillStyle = color;
    ctx.fill(MG._fin);
    ctx.restore();
  };

  MG.Screen = function () {
    var c = document.createElement("canvas");
    c.width = SW; c.height = SH;
    var w = document.createElement("canvas");
    w.width = SW; w.height = SH;
    this.canvas = c;
    this.ctx = c.getContext("2d");
    this.wallC = w;
    this.wx = w.getContext("2d");
  };
  var SP = MG.Screen.prototype;
  // Liquid wallpaper: slow drifting yellow-lit pools on black (block recipe).
  SP.wall = function (t, glow) {
    var wx = this.wx, g = glow == null ? 1 : glow;
    wx.globalCompositeOperation = "source-over";
    wx.filter = "none";
    wx.fillStyle = "#020202";
    wx.fillRect(0, 0, SW, SH);
    var blobs = [
      [0.25, 0.72, 260, 0.55, 0.21, 0.0],
      [0.85, 0.42, 220, 0.38, 0.17, 1.7],
      [0.5, 0.18, 200, 0.22, 0.13, 3.1],
      [0.1, 0.35, 160, 0.18, 0.19, 4.2],
    ];
    wx.globalCompositeOperation = "lighter";
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      var cx = b[0] * SW + Math.sin(t * b[4] * 3 + b[5]) * 46;
      var cy = b[1] * SH + Math.cos(t * b[4] * 2.4 + b[5]) * 60;
      var gr = wx.createRadialGradient(cx, cy, 0, cx, cy, b[2]);
      gr.addColorStop(0, "rgba(250,204,21," + b[3] * g + ")");
      gr.addColorStop(0.35, "rgba(160,120,10," + b[3] * 0.45 * g + ")");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      wx.fillStyle = gr;
      wx.fillRect(0, 0, SW, SH);
    }
    wx.filter = "blur(6px)";
    for (var k = 0; k < 3; k++) {
      wx.beginPath();
      for (var s = 0; s <= 24; s++) {
        var yy = (s / 24) * SH;
        var xx = SW * (0.2 + k * 0.3) + Math.sin(yy * 0.009 + t * 0.6 + k * 2.1) * 70 + Math.sin(yy * 0.021 - t * 0.4 + k) * 22;
        s ? wx.lineTo(xx, yy) : wx.moveTo(xx, yy);
      }
      wx.strokeStyle = "rgba(255,226,120," + (0.22 - k * 0.05) * g + ")";
      wx.lineWidth = 10 - k * 2;
      wx.stroke();
    }
    wx.filter = "none";
    wx.globalCompositeOperation = "source-over";
    this.ctx.globalAlpha = 1;
    this.ctx.filter = "none";
    this.ctx.drawImage(this.wallC, 0, 0);
  };
  // The block's glass recipe: refracted+blurred backdrop, tint, caustic, rim, specular.
  SP.glass = function (x, y, w, h, r, q, tint, src) {
    if (q <= 0.001) return;
    var ctx = this.ctx, back = src || this.wallC;
    ctx.save();
    ctx.globalAlpha = Math.min(1, q);
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 14;
    rr(ctx, x, y, w, h, r);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();
    ctx.shadowColor = "transparent";
    rr(ctx, x, y, w, h, r);
    ctx.clip();
    var m = 1.12, cx = x + w / 2, cy = y + h / 2;
    ctx.filter = "blur(14px) saturate(1.5) brightness(1.35)";
    ctx.drawImage(back, cx - cx * m, cy - cy * m, SW * m, SH * m);
    ctx.filter = "none";
    var fill = ctx.createLinearGradient(x, y, x + w, y + h);
    if (tint === "yes") {
      fill.addColorStop(0, "rgba(250,204,21,0.92)");
      fill.addColorStop(1, "rgba(226,178,10,0.82)");
    } else if (tint === "no") {
      fill.addColorStop(0, "rgba(217,74,61,0.88)");
      fill.addColorStop(1, "rgba(170,52,42,0.80)");
    } else if (tint === "ink") {
      fill.addColorStop(0, "rgba(10,10,10,0.72)");
      fill.addColorStop(1, "rgba(0,0,0,0.6)");
    } else if (tint === "sheet") {
      fill.addColorStop(0, "rgba(28,28,28,0.62)");
      fill.addColorStop(1, "rgba(12,12,12,0.72)");
    } else {
      fill.addColorStop(0, "rgba(255,255,255,0.22)");
      fill.addColorStop(0.45, "rgba(237,230,214,0.12)");
      fill.addColorStop(1, "rgba(255,255,255,0.06)");
    }
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = "screen";
    var caustic = ctx.createLinearGradient(x + 40, y, x + w - 20, y + h);
    caustic.addColorStop(0, "rgba(255,255,255,0.16)");
    caustic.addColorStop(0.4, "rgba(250,204,21,0.07)");
    caustic.addColorStop(1, "rgba(255,255,255,0.03)");
    ctx.fillStyle = caustic;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = "source-over";
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = Math.min(1, q);
    rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
    var rim = ctx.createLinearGradient(x, y, x, y + h);
    rim.addColorStop(0, "rgba(255,255,255,0.75)");
    rim.addColorStop(0.5, "rgba(255,255,255,0.18)");
    rim.addColorStop(1, "rgba(255,255,255,0.45)");
    ctx.strokeStyle = rim;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + r, y + 6);
    ctx.bezierCurveTo(x + w * 0.3, y + 1, x + w * 0.6, y + 4, x + w - r, y + 7);
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  };
  // Snapshot of what is on the screen so far (for glass that floats over UI, e.g. sheets).
  SP.freeze = function () {
    if (!this.frozenC) {
      this.frozenC = document.createElement("canvas");
      this.frozenC.width = SW; this.frozenC.height = SH;
    }
    var f = this.frozenC.getContext("2d");
    f.clearRect(0, 0, SW, SH);
    f.drawImage(this.canvas, 0, 0);
    return this.frozenC;
  };
  SP.header = function (alpha) {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    MG.fin(ctx, 26, 62, 24, "#EDE6D6");
    ctx.fillStyle = "#EDE6D6";
    ctx.font = "800 19px " + MG.BR;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText("Mako Market", 54, 74);
    ctx.font = "600 10px " + MG.MO;
    ctx.fillStyle = "rgba(237,230,214,0.6)";
    ctx.textAlign = "right";
    ctx.fillText("MAKOMARKET.XYZ", SW - 24, 74);
    ctx.restore();
  };
  SP.homeBar = function () {
    var ctx = this.ctx;
    rr(ctx, SW / 2 - 68, SH - 18, 136, 5, 3);
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.fill();
  };
  SP.text = function (s, x, y, font, color, align, alpha, base) {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align || "left";
    ctx.textBaseline = base || "alphabetic";
    ctx.fillText(s, x, y);
    ctx.restore();
  };
  SP.chip = function (label, x, y, alpha, fill, color) {
    var ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.font = "600 10.5px " + MG.MO;
    var w = ctx.measureText(label).width + 22;
    rr(ctx, x, y, w, 24, 12);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    else { ctx.strokeStyle = "rgba(237,230,214,0.5)"; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = color || "#EDE6D6";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + 11, y + 12.5);
    ctx.restore();
    return w;
  };
  // value-free trend line
  SP.trend = function (x, y, w, h, t, alpha, color, pts) {
    var ctx = this.ctx;
    pts = pts || [0.2, 0.32, 0.27, 0.46, 0.4, 0.58, 0.52, 0.66, 0.74, 0.8];
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var px = x + (i / (pts.length - 1)) * w;
      var py = y + h - pts[i] * h + Math.sin(t * 1.3 + i) * 2;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.strokeStyle = color || "rgba(250,204,21,0.85)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  };

  // Pools list (sample questions, no numbers) used as the base page in several shots.
  MG.POOLS = [
    ["CRYPTO", "Will Bitcoin close", "the week higher?"],
    ["FOOTBALL", "Will the home side", "win on Saturday?"],
    ["NBA", "Will the favourites", "win tonight?"],
    ["FOREX", "Will EUR/USD end", "the day up?"],
    ["COMMODITIES", "Will gold close", "the week higher?"],
    ["STOCKS", "Will tech stocks", "close green Friday?"],
  ];
  SP.poolList = function (t, scroll, top, glassOn) {
    var c = this.ctx;
    c.save();
    c.beginPath();
    c.rect(0, top, SW, SH - top);
    c.clip();
    for (var k = 0; k < MG.POOLS.length; k++) {
      var y = top + 8 + k * 170 - scroll;
      if (y > SH || y + 156 < top - 20) continue;
      if (glassOn) this.glass(14, y, 362, 156, 26, 1, "clear");
      else {
        rr(c, 14, y, 362, 156, 26);
        c.fillStyle = "rgba(255,255,255,0.07)";
        c.fill();
        c.strokeStyle = "rgba(255,255,255,0.18)";
        c.lineWidth = 1;
        c.stroke();
      }
      this.chip(MG.POOLS[k][0], 30, y + 16, 1);
      this.text(MG.POOLS[k][1], 30, y + 72, "800 23px " + MG.BR, "#EDE6D6");
      this.text(MG.POOLS[k][2], 30, y + 99, "800 23px " + MG.BR, "#EDE6D6");
      rr(c, 30, y + 114, 76, 30, 12);
      c.fillStyle = "rgba(250,204,21,0.85)";
      c.fill();
      rr(c, 114, y + 114, 76, 30, 12);
      c.fillStyle = "rgba(217,74,61,0.85)";
      c.fill();
      this.text("YES", 68, y + 130, "800 14px " + MG.BR, "#000", "center", 1, "middle");
      this.text("NO", 152, y + 130, "800 14px " + MG.BR, "#EDE6D6", "center", 1, "middle");
      this.trend(214, y + 112, 140, 32, t + k, 0.8);
    }
    c.restore();
  };
  SP.scrim = function (a) {
    var c = this.ctx;
    c.save();
    c.fillStyle = "rgba(0,0,0," + a + ")";
    c.fillRect(0, 0, SW, SH);
    c.restore();
  };

  // Text canvas for a 3D slab face (pixel units, origin top-left).
  MG.faceCanvas = function (pw, ph) {
    var c = document.createElement("canvas");
    c.width = pw; c.height = ph;
    var x = c.getContext("2d");
    x.textAlign = "left";
    x.textBaseline = "alphabetic";
    return c;
  };

  // ── WebGL world (one context for every GLASS shot) ────────────────
  var renderer, scene, camera, bgU, bgPlane, phoneGrp, phoneTex, rt, rimL, keyL, warmL, ambL;
  var slabs = [];
  var SLAB_VS =
    "varying vec3 vLp;varying vec3 vNl;varying vec3 vNv;varying vec4 vCp;varying vec3 vVd;" +
    "void main(){vLp=position;vNl=normal;vNv=normalize(normalMatrix*normal);" +
    "vec4 mv=modelViewMatrix*vec4(position,1.0);vVd=normalize(-mv.xyz);vCp=projectionMatrix*mv;gl_Position=vCp;}";
  var SLAB_FS =
    "uniform sampler2D uBack;uniform sampler2D uText;uniform vec2 uSize;uniform float uFrost;uniform float uHasText;" +
    "uniform float uSheen;uniform vec3 uTint;uniform float uLift;uniform float uGlow;" +
    "varying vec3 vLp;varying vec3 vNl;varying vec3 vNv;varying vec4 vCp;varying vec3 vVd;" +
    "void main(){vec2 suv=vCp.xy/vCp.w*0.5+0.5;vec3 n=normalize(vNv);" +
    "float edge=1.0-clamp(abs(vNl.z),0.0,1.0);" +
    "vec2 off=n.xy*(0.03+0.07*edge);vec2 uv=suv-off;" +
    "vec3 acc=texture2D(uBack,uv).rgb*2.0;float wsum=2.0;" +
    "for(int i=0;i<10;i++){float a=float(i)*0.6283;vec2 d=vec2(cos(a),sin(a)*1.7778);" +
    "acc+=texture2D(uBack,uv+d*uFrost).rgb;acc+=texture2D(uBack,uv+d*uFrost*0.45).rgb;wsum+=2.0;}" +
    "vec3 b=pow(max(acc/wsum,0.0),vec3(0.8));" +
    "vec3 col=b*uLift+uTint;" +
    "float fr=pow(1.0-max(dot(n,normalize(vVd)),0.0),2.2);" +
    "col+=fr*vec3(1.0,0.94,0.78)*0.8+edge*vec3(0.16,0.14,0.09);" +
    "float s=vLp.x/uSize.x*0.8+vLp.y/uSize.y*0.5;" +
    "col+=exp(-pow((s-uSheen)*6.0,2.0))*0.10*(1.0-edge)*vec3(1.0,0.97,0.88);" +
    "float top=smoothstep(0.40,0.5,vLp.y/uSize.y)*(1.0-edge);col+=top*0.05;" +
    "col+=uGlow*vec3(0.98,0.80,0.08)*0.12*(1.0-edge);" +
    "if(uHasText>0.5&&vNl.z>0.9){vec2 tuv=vLp.xy/uSize+0.5;vec4 t=texture2D(uText,tuv);col=mix(col,t.rgb,t.a);}" +
    "gl_FragColor=vec4(col,1.0);}";

  function build() {
    var gl = document.createElement("canvas");
    gl.width = W; gl.height = H;
    renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(W, H, false);
    renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.setClearColor(0x000000, 1);
    MG.renderer = renderer;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    camera = new THREE.PerspectiveCamera(34, W / H, 0.1, 100);
    scene.add(camera);
    MG.scene = scene;
    MG.camera = camera;

    // environment (block's studio strip env, warmed)
    var eC = document.createElement("canvas");
    eC.width = 1024; eC.height = 512;
    var ec = eC.getContext("2d");
    var eg = ec.createLinearGradient(0, 0, 1024, 512);
    eg.addColorStop(0, "#020202");
    eg.addColorStop(0.15, "#17140a");
    eg.addColorStop(0.3, "#ffffff");
    eg.addColorStop(0.45, "#0a0905");
    eg.addColorStop(0.6, "#fff3c4");
    eg.addColorStop(0.75, "#1c180c");
    eg.addColorStop(1, "#020202");
    ec.fillStyle = eg;
    ec.fillRect(0, 0, 1024, 512);
    ec.globalCompositeOperation = "screen";
    for (var ei = 0; ei < 7; ei++) {
      ec.fillStyle = "rgba(255,255,255," + (ei % 2 === 0 ? 0.15 : 0.08) + ")";
      ec.fillRect((ei % 3) * 100, 60 + ei * 56, 700, 3 + (ei % 2) * 2);
    }
    var eT = new THREE.CanvasTexture(eC);
    eT.mapping = THREE.EquirectangularReflectionMapping;
    var pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromEquirectangular(eT).texture;
    eT.dispose();
    pm.dispose();

    // liquid backdrop, parented to the camera so every angle is covered
    bgU = {
      uTime: { value: 0 },
      uAspect: { value: W / H },
      uOff: { value: new THREE.Vector2(0, 0) },
      uGlow: { value: new THREE.Vector3(0.55, -0.35, 0.06) },
      uRib: { value: 1.0 },
    };
    bgPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: bgU,
        vertexShader: "varying vec2 v;void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader:
          "uniform float uTime;uniform float uAspect;uniform vec2 uOff;uniform vec3 uGlow;uniform float uRib;varying vec2 v;" +
          "float wave(vec2 p,float s,float t){return sin(p.x*s+p.y*s*.57+uTime*t);}" +
          "void main(){vec2 p=v*2.0-1.0;p.x*=uAspect;vec2 sp=p;p+=uOff;" +
          "vec2 q=p+0.18*vec2(sin(p.y*2.3+uTime*.21),cos(p.x*1.9-uTime*.17));" +
          "float w=wave(q,3.0,.22)+.55*wave(q.yx+vec2(.7,-.2),5.1,.16)+.32*wave(q+vec2(-.4,.5),8.0,-.12);" +
          "float a=smoothstep(-.6,1.2,w);" +
          "vec3 ink=vec3(.004,.004,.005);vec3 oil=vec3(.035,.03,.018);vec3 sig=vec3(.98,.80,.08);" +
          "vec3 c=mix(ink,oil,a);" +
          "float rib=pow(smoothstep(.55,1.0,sin(q.x*2.0-q.y*2.8+uTime*.16)),3.0);" +
          "float rib2=pow(smoothstep(.75,1.0,sin(q.x*3.3+q.y*1.7-uTime*.12+1.3)),4.0);" +
          "c+=(sig*rib*.13*a+sig*rib2*.06)*uRib;" +
          "vec2 gd=sp-uGlow.xy;float glow=exp(-dot(gd,gd)*1.2);c+=sig*glow*uGlow.z;" +
          "float vign=smoothstep(1.9,.2,length(sp*vec2(.8,1.0)));gl_FragColor=vec4(c*vign,1.0);}",
        depthTest: false,
        depthWrite: false,
      }),
    );
    bgPlane.renderOrder = -10;
    bgPlane.frustumCulled = false;
    camera.add(bgPlane);

    ambL = new THREE.AmbientLight(0x222222, 0.45);
    scene.add(ambL);
    keyL = new THREE.DirectionalLight(0xffffff, 2.0);
    keyL.position.set(-3, 4, 5);
    scene.add(keyL);
    rimL = new THREE.PointLight(0xfacc15, 3.2, 15);
    rimL.position.set(4, 2, 3);
    scene.add(rimL);
    warmL = new THREE.PointLight(0xffe7a8, 1.3, 12);
    warmL.position.set(-3, -1, 4);
    scene.add(warmL);

    phoneTex = new THREE.CanvasTexture(document.createElement("canvas"));
    phoneTex.minFilter = THREE.LinearFilter;
    phoneTex.magFilter = THREE.LinearFilter;
    phoneTex.generateMipmaps = false;
    phoneTex.encoding = THREE.sRGBEncoding;
    phoneGrp = new THREE.Group();
    scene.add(phoneGrp);
    MG.phone = phoneGrp;

    rt = new THREE.WebGLRenderTarget(480, 270, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
  }

  function planarScreenUv(mesh) {
    var g = mesh.geometry;
    g.computeBoundingBox();
    var bb = g.boundingBox, pos = g.attributes.position;
    var w = bb.max.x - bb.min.x || 1, h = bb.max.y - bb.min.y || 1;
    var uv = new Float32Array(pos.count * 2);
    for (var i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) - bb.min.x) / w;
      uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / h;
    }
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  function alignScreenToMinusZ(root, frontName, backName) {
    var front = root.getObjectByName(frontName), back = root.getObjectByName(backName);
    if (!front || !back) return;
    root.updateWorldMatrix(true, true);
    var fp = new THREE.Vector3(), bp = new THREE.Vector3();
    front.getWorldPosition(fp);
    back.getWorldPosition(bp);
    if (fp.z > bp.z) root.rotation.y += Math.PI;
  }
  function loadPhone() {
    return new Promise(function (res) {
      new THREE.GLTFLoader().load(base + "iphone.glb", function (gltf) {
        var m = gltf.scene;
        var box = new THREE.Box3().setFromObject(m);
        var sz = box.getSize(new THREE.Vector3());
        m.scale.setScalar(3.2 / sz.y);
        box.setFromObject(m);
        m.position.sub(box.getCenter(new THREE.Vector3()));
        m.traverse(function (child) {
          if (!child.isMesh) return;
          if (child.name.indexOf("front-glass") === 0) {
            planarScreenUv(child);
            child.material = new THREE.MeshBasicMaterial({ map: phoneTex, toneMapped: false });
          } else if (child.material) {
            var mm = child.material.clone();
            if (mm.color) mm.color.setHex(0x1c1c1c);
            if ("metalness" in mm) mm.metalness = 1.0;
            if ("roughness" in mm) mm.roughness = Math.min(mm.roughness, 0.32);
            child.material = mm;
          }
        });
        alignScreenToMinusZ(m, "front-glass", "rear-window");
        phoneGrp.add(m);
        res();
      }, undefined, function () { res(); });
    });
  }

  // Frosted glass slab. Front face (+Z local) carries `face` (canvas) as etched text.
  MG.slab = function (o) {
    var w = o.w, h = o.h, r = o.r || 0.18, d = o.depth || 0.1, bv = o.bevel || 0.05;
    var sh = new THREE.Shape();
    var x = -w / 2, y = -h / 2;
    sh.moveTo(x + r, y);
    sh.lineTo(x + w - r, y);
    sh.quadraticCurveTo(x + w, y, x + w, y + r);
    sh.lineTo(x + w, y + h - r);
    sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    sh.lineTo(x + r, y + h);
    sh.quadraticCurveTo(x, y + h, x, y + h - r);
    sh.lineTo(x, y + r);
    sh.quadraticCurveTo(x, y, x + r, y);
    var geo = new THREE.ExtrudeGeometry(sh, {
      depth: d, bevelEnabled: true, bevelThickness: bv, bevelSize: bv * 0.9,
      bevelSegments: 4, curveSegments: 8,
    });
    geo.translate(0, 0, -d / 2);
    var tex = null;
    if (o.face) {
      tex = new THREE.CanvasTexture(o.face);
      tex.encoding = THREE.LinearEncoding;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = 4;
    }
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uBack: { value: rt.texture },
        uText: { value: tex },
        uHasText: { value: tex ? 1 : 0 },
        uSize: { value: new THREE.Vector2(w, h) },
        uFrost: { value: o.frost || 0.012 },
        uSheen: { value: -1 },
        uTint: { value: new THREE.Color(o.tint || 0x0b0a07) },
        uLift: { value: o.lift || 0.95 },
        uGlow: { value: 0 },
      },
      vertexShader: SLAB_VS,
      fragmentShader: SLAB_FS,
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.userData.tex = tex;
    (o.parent === "phone" ? phoneGrp : scene).add(mesh);
    slabs.push(mesh);
    return mesh;
  };

  /*
    MG.render(o, ctx2d)
    o.cam: {x,y,z, lx,ly,lz, fov}
    o.bg: {t, gx, gy, gs, rib, ox, oy}
    o.phone: null | {x,y,z, rx,ry,rz, screen: canvas}
    o.slabs: [{mesh, x,y,z, rx,ry,rz, s, sheen, glow}]
    o.rim: [x,y,z,intensity]
  */
  var tmpV = null;
  MG.render = function (o, ctx2d) {
    if (!MG.isReady) return;
    var c = o.cam;
    camera.fov = c.fov || 34;
    camera.updateProjectionMatrix();
    camera.position.set(c.x, c.y, c.z);
    camera.lookAt(c.lx || 0, c.ly || 0, c.lz || 0);
    camera.updateMatrixWorld(true);
    var dist = 40;
    var hh = 2 * dist * Math.tan((camera.fov * PI) / 360) * 1.08;
    bgPlane.position.set(0, 0, -dist);
    bgPlane.scale.set(hh * (W / H), hh, 1);
    var b = o.bg || {};
    bgU.uTime.value = b.t || 0;
    bgU.uOff.value.set(b.ox || 0, b.oy || 0);
    bgU.uGlow.value.set(b.gx == null ? 0.55 : b.gx, b.gy == null ? -0.35 : b.gy, b.gs == null ? 0.06 : b.gs);
    bgU.uRib.value = b.rib == null ? 1 : b.rib;
    var rm = o.rim || [4, 2, 3, 3.2];
    rimL.position.set(rm[0], rm[1], rm[2]);
    rimL.intensity = rm[3];
    var p = o.phone;
    phoneGrp.visible = !!p;
    if (p) {
      phoneGrp.position.set(p.x || 0, p.y || 0, p.z || 0);
      phoneGrp.rotation.set(p.rx || 0, p.ry || 0, p.rz || 0);
      if (p.screen) {
        phoneTex.image = p.screen;
        phoneTex.needsUpdate = true;
      }
    }
    var list = o.slabs || [];
    for (var i = 0; i < slabs.length; i++) slabs[i].visible = false;
    for (var j = 0; j < list.length; j++) {
      var sl = list[j], m = sl.mesh;
      m.position.set(sl.x || 0, sl.y || 0, sl.z || 0);
      m.rotation.set(sl.rx || 0, sl.ry || 0, sl.rz || 0);
      m.scale.setScalar(sl.s == null ? 1 : sl.s);
      m.material.uniforms.uSheen.value = sl.sheen == null ? -1 : sl.sheen;
      m.material.uniforms.uGlow.value = sl.glow || 0;
    }
    if (list.length) {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      for (var k = 0; k < list.length; k++) list[k].mesh.visible = list[k].hidden ? false : true;
    }
    renderer.render(scene, camera);
    if (ctx2d) {
      ctx2d.globalAlpha = 1;
      ctx2d.drawImage(renderer.domElement, 0, 0, W, H);
    }
  };

  MG.ready = (window.THREE ? Promise.resolve() : load("three.min.js"))
    .then(function () { return THREE.GLTFLoader ? null : load("GLTFLoader.js"); })
    .then(function () { build(); return Promise.all([loadPhone(), MG.fonts()]); })
    .then(function () { MG.isReady = true; });
})();
