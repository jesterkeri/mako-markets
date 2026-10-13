        // Shot 35: leaderboard rows (ranks 01 to 05, names as blank bars, no scores) drop from an exploded
        // stack onto the board, 05 first; 01 lands last and lifts in yellow. Camera: iso left.
        function setup() {

          const renderer = K.makeRenderer(document.getElementById("s35-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const BW = 4.9, BD = 4.9, BT = 0.12;
          const RW = 4.3, RD = 0.64, RT = 0.1, PITCH = 0.78, TW = 860, TH = 128;
          const Z0 = -BD / 2 + 1.05;

          function boardTex() {
            const [c, g] = K.canvas2d(980, 980);
            g.fillStyle = K.C.sheet;
            g.fillRect(0, 0, 980, 980);
            g.strokeStyle = "rgba(0,0,0,0.16)";
            g.lineWidth = 2;
            g.strokeRect(1, 1, 978, 978);
            K.fin(g, 60, 52, 0.12);
            K.rr(g, 124, 66, 260, 26, 13);
            g.fillStyle = "rgba(0,0,0,0.75)";
            g.fill();
            K.rr(g, 700, 66, 220, 26, 13);
            g.fillStyle = "rgba(0,0,0,0.12)";
            g.fill();
            g.fillStyle = "rgba(0,0,0,0.12)";
            g.fillRect(60, 140, 860, 2);
            return K.tex(renderer, c);
          }
          function rowTex(k) {
            const [c, g] = K.canvas2d(TW, TH);
            const first = k === 0;
            K.rr(g, 2, 2, TW - 4, TH - 4, 22);
            g.fillStyle = first ? K.C.yes : "#FBF8F1";
            g.fill();
            g.lineWidth = first ? 3 : 2;
            g.strokeStyle = first ? "#000" : "rgba(0,0,0,0.3)";
            g.stroke();
            g.fillStyle = "#000";
            g.font = "800 58px " + K.BR;
            g.textBaseline = "middle";
            g.fillText("0" + (k + 1), 40, TH / 2 + 2);
            g.beginPath();
            g.arc(196, TH / 2, 30, 0, Math.PI * 2);
            g.fillStyle = first ? "rgba(0,0,0,0.85)" : "rgba(0,0,0,0.16)";
            g.fill();
            K.rr(g, 248, TH / 2 - 15, [330, 280, 360, 240, 300][k], 30, 15);
            g.fillStyle = first ? "rgba(0,0,0,0.75)" : "rgba(0,0,0,0.2)";
            g.fill();
            return K.tex(renderer, c);
          }

          const shadow = K.shadowBlob(7.2, 7.2, 0.24);
          shadow.position.y = -BT - 0.02;
          scene.add(shadow);
          const board = K.slab(BW, BT, BD, boardTex(), K.edgeMaterial(), 0.05, 10);
          board.group.position.y = -BT / 2;
          scene.add(board.group);
          const edge = K.edgeMaterial(0xf0ebe0);
          const yesEdge = K.colorMaterial(K.C.yes, 0.6);
          const rows = [0, 1, 2, 3, 4].map((k) => {
            const s = K.slab(RW, RT, RD, rowTex(k), k === 0 ? yesEdge : edge, 0.04, 20 + k);
            scene.add(s.group);
            const slot = K.dashedRect(RW, RD, 0.07, 0.05);
            slot.position.set(0, 0.003, Z0 + k * PITCH);
            scene.add(slot);
            return { g: s.group, slot };
          });

          function render(t) {
            const drift = K.eInOut(t / DUR);
            cam.place(K.lerp(-36, -27, drift), K.lerp(33, 37, drift), [0, K.lerp(0.9, 0.2, K.eInOut(K.seg(t, 0.1, 0.8))), 0], [1230, 590], K.lerp(1.0, 1.1, drift));
            for (let k = 0; k < 5; k++) {
              const order = 4 - k; // 05 lands first, 01 last
              const at = 0.08 + order * 0.085;
              const u = K.eIn(K.seg(t, at, 0.34));
              const landT = at + 0.34;
              const startY = 0.7 + (4 - k) * 0.56; // exploded: 01 highest
              const startZ = Z0 + k * PITCH - (4 - k) * 0.12;
              let y = K.lerp(startY, RT / 2, u) + K.bump(t, landT, 0.4, 7) * 0.06;
              if (k === 0) y += 0.24 * K.eBack(K.seg(t, landT + 0.04, 0.32));
              rows[k].g.position.set(0, y, K.lerp(startZ, Z0 + k * PITCH, u));
              rows[k].slot.material.opacity = 0.5 * (1 - K.clamp01((t - landT) / 0.12));
            }
            renderer.render(scene, cam);
          }
          function tweens(tl) {
            tl.fromTo("#s35-l1", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.08);
            tl.fromTo("#s35-l2", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.18);
          }
          return { render, tweens };
        }
