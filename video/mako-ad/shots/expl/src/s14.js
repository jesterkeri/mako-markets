        // Shot 14: the sign-in card explodes into three labelled layers (email, code, wallet).
        // Camera: steep plan view rotating slowly (no other EXPL shot looks this far down).
        function setup() {
          const renderer = K.makeRenderer(document.getElementById("s14-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const { w: CW, d: CD, tw: TW, th: TH } = K.CARD;
          const THICK = 0.16, GAP = 1.35, SHEET = 0.012, N = 3;
          const GREY = "rgba(0,0,0,0.13)";
          const mk = () => K.canvas2d(TW, TH);
          const bar = (g, x, y, w, h, col) => { K.rr(g, x, y, w, h, h / 2); g.fillStyle = col; g.fill(); };

          // 03 WALLET: the card base. Header, then a wallet row (fin badge, blank address, check).
          function wallet() {
            const [c, g] = mk();
            g.fillStyle = K.C.sheet;
            g.fillRect(0, 0, TW, TH);
            g.strokeStyle = "rgba(0,0,0,0.16)";
            g.lineWidth = 2;
            g.strokeRect(1, 1, TW - 2, TH - 2);
            K.fin(g, 40, 38, 0.11);
            g.fillStyle = "#000";
            g.font = "800 28px " + K.BR;
            g.textBaseline = "middle";
            g.fillText("Mako Market", 94, 56);
            g.fillStyle = "rgba(0,0,0,0.12)";
            g.fillRect(40, 108, TW - 80, 1.5);
            K.soft(g, true);
            K.rr(g, 40, 630, TW - 80, 150, 22);
            g.fillStyle = "#FBF8F1";
            g.fill();
            K.soft(g, false);
            g.lineWidth = 1.5;
            g.strokeStyle = "rgba(0,0,0,0.3)";
            K.rr(g, 40, 630, TW - 80, 150, 22);
            g.stroke();
            g.beginPath();
            g.arc(112, 705, 40, 0, Math.PI * 2);
            g.fillStyle = "#000";
            g.fill();
            K.fin(g, 87, 682, 0.125, K.C.yes);
            bar(g, 176, 678, 250, 22, "rgba(0,0,0,0.7)");
            bar(g, 176, 716, 170, 18, GREY);
            g.beginPath();
            g.arc(TW - 92, 705, 26, 0, Math.PI * 2);
            g.fillStyle = K.C.yes;
            g.fill();
            g.beginPath();
            g.moveTo(TW - 104, 706); g.lineTo(TW - 95, 715); g.lineTo(TW - 80, 695);
            g.lineWidth = 5; g.strokeStyle = "#000"; g.lineCap = "round"; g.lineJoin = "round";
            g.stroke();
            return K.tex(renderer, c);
          }
          // 01 EMAIL: field with a placeholder address and a caret.
          function email() {
            const [c, g] = mk();
            bar(g, 40, 168, 120, 18, "rgba(0,0,0,0.25)");
            K.soft(g, true);
            K.rr(g, 40, 202, TW - 80, 96, 18);
            g.fillStyle = "#FBF8F1";
            g.fill();
            K.soft(g, false);
            g.lineWidth = 2.5;
            g.strokeStyle = "#000";
            K.rr(g, 40, 202, TW - 80, 96, 18);
            g.stroke();
            g.fillStyle = "rgba(0,0,0,0.45)";
            g.font = "500 36px " + K.IN;
            g.textBaseline = "middle";
            g.fillText("you@email.com", 72, 251);
            g.fillStyle = "#000";
            g.fillRect(72 + g.measureText("you@email.com").width + 6, 228, 3, 46);
            return K.tex(renderer, c);
          }
          // 02 CODE: six code boxes, a few filled with dots (no digits).
          function code() {
            const [c, g] = mk();
            bar(g, 40, 412, 150, 18, "rgba(0,0,0,0.25)");
            const w = (TW - 80 - 5 * 14) / 6;
            for (let k = 0; k < 6; k++) {
              const x = 40 + k * (w + 14);
              K.soft(g, true);
              K.rr(g, x, 446, w, 110, 16);
              g.fillStyle = "#FBF8F1";
              g.fill();
              K.soft(g, false);
              g.lineWidth = k === 3 ? 3 : 1.5;
              g.strokeStyle = k === 3 ? "#000" : "rgba(0,0,0,0.35)";
              K.rr(g, x, 446, w, 110, 16);
              g.stroke();
              if (k < 3) {
                g.beginPath();
                g.arc(x + w / 2, 501, 11, 0, Math.PI * 2);
                g.fillStyle = "#000";
                g.fill();
              }
            }
            return K.tex(renderer, c);
          }

          const shadow = K.shadowBlob(6.0, 7.2);
          scene.add(shadow);
          const base = K.slab(CW, THICK, CD, wallet(), K.edgeMaterial(), 0.05, 10);
          scene.add(base.group);
          const sheets = [code(), email()].map((m, k) => {
            const s = K.sheet(CW, CD, m, k + 1);
            scene.add(s.group);
            return s;
          });
          const plates = [base.group, ...sheets.map((s) => s.group)];
          // layer i (0 = base) -> label
          const C = K.callouts(ROOT, [
            { idx: "03", name: "WALLET", accent: true },
            { idx: "02", name: "CODE" },
            { idx: "01", name: "EMAIL" },
          ], "s14");

          const OPEN_AT = 0.06, OPEN_FOR = 0.62, OPEN_STAGGER = 0.07;
          const LAND_AT = 0.3, LAND_EVERY = 0.1, DRAW = 0.26;

          function render(t) {
            const turn = K.eInOut(t / DUR);
            cam.place(K.lerp(-22, -8, turn), K.lerp(66, 61, turn), [0, 0.2, 0], [1100, 545], K.lerp(0.86, 0.92, turn));
            let topOpen = 0;
            for (let i = 0; i < N; i++) {
              const order = N - 1 - i; // top sheet leaves first
              const o = K.eOpen((t - OPEN_AT - order * OPEN_STAGGER) / OPEN_FOR);
              if (i === N - 1) topOpen = o;
              const settle = K.bump(t, OPEN_AT + order * OPEN_STAGGER + OPEN_FOR * 0.75, 0.5, 6) * 0.05 * (i - 1);
              const y = (i - (N - 1) / 2) * o * GAP + (i === 0 ? -THICK / 2 : i * SHEET) + settle;
              // seen from this high, height alone barely separates the layers: they also step back along the card
              const sx = (i - (N - 1) / 2) * o * -0.3, sz = (i - (N - 1) / 2) * o * -0.8;
              plates[i].position.set(sx, y, sz);
              if (i === 0) shadow.position.set(sx, y - THICK / 2 - 0.5 - o * 0.2, sz);
              const ay = y + (i === 0 ? THICK / 2 : 0);
              const best = cam.toScreen(sx + CW / 2, ay, sz);
              C.place(i, best[0], best[1], 1480, K.eOut((t - LAND_AT - order * LAND_EVERY) / DRAW));
            }
            for (const s of sheets) {
              s.frame.opacity = 0.55 * topOpen;
              s.acetate.opacity = 0.18 * topOpen;
            }
            renderer.render(scene, cam);
          }
          function tweens(tl) {
            tl.fromTo("#s14-l1", { yPercent: 130 }, { yPercent: 0, duration: 0.5, ease: "power3.out" }, 0.08);
            tl.fromTo("#s14-l2", { yPercent: 130 }, { yPercent: 0, duration: 0.5, ease: "power3.out" }, 0.16);
          }
          return { render, tweens };
        }
