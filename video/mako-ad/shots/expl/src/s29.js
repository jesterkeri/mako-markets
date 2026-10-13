        // Shot 29: the four create steps as stacked sheets fanning out from one corner. Camera: high, near frontal.
        function setup() {

          const renderer = K.makeRenderer(document.getElementById("s29-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const SW = 3.3, SD = 2.1, TW = 660, TH = 420, THK = 0.05;
          const GREY = "rgba(0,0,0,0.13)", GREY2 = "rgba(0,0,0,0.22)";

          function screen(k) {
            const [c, g] = K.canvas2d(TW, TH);
            g.fillStyle = K.C.sheet;
            g.fillRect(0, 0, TW, TH);
            g.strokeStyle = "rgba(0,0,0,0.16)";
            g.lineWidth = 2;
            g.strokeRect(1, 1, TW - 2, TH - 2);
            K.fin(g, 30, 26, 0.075);
            // step progress: four segments, current one black
            for (let s = 0; s < 4; s++) {
              K.rr(g, 330 + s * 74, 36, 64, 8, 4);
              g.fillStyle = s < k ? GREY2 : s === k ? "#000" : GREY;
              g.fill();
            }
            g.fillStyle = "rgba(0,0,0,0.1)";
            g.fillRect(30, 70, TW - 60, 1.5);
            const bar = (x, y, w, h = 18, col = GREY) => { K.rr(g, x, y, w, h, h / 2); g.fillStyle = col; g.fill(); };
            if (k === 0) {
              // market: question field + category pills
              K.rr(g, 30, 100, TW - 60, 120, 16);
              g.fillStyle = "#FBF8F1"; g.fill();
              g.lineWidth = 2; g.strokeStyle = "#000"; g.stroke();
              bar(56, 132, 380, 22, "rgba(0,0,0,0.75)");
              bar(56, 172, 250, 22, "rgba(0,0,0,0.75)");
              K.rr(g, 450, 128, 4, 70, 2); g.fillStyle = "#000"; g.fill();
              [110, 90, 120, 100].forEach((w, i) => {
                const x = 30 + [0, 124, 228, 362][i];
                K.rr(g, x, 252, w, 44, 22);
                g.fillStyle = i === 0 ? K.C.yes : "#FBF8F1"; g.fill();
                g.lineWidth = 1.5; g.strokeStyle = "rgba(0,0,0,0.35)"; g.stroke();
                bar(x + 22, 266, w - 44, 16, i === 0 ? "rgba(0,0,0,0.6)" : GREY2);
              });
              bar(30, 330, 220, 16);
            } else if (k === 1) {
              // timing and source: a time track with two handles, then a source row
              bar(30, 100, 160, 16, GREY2);
              K.rr(g, 30, 140, TW - 60, 10, 5); g.fillStyle = GREY; g.fill();
              K.rr(g, 150, 140, 300, 10, 5); g.fillStyle = "#000"; g.fill();
              for (const x of [150, 450]) {
                g.beginPath(); g.arc(x, 145, 15, 0, Math.PI * 2);
                g.fillStyle = "#FBF8F1"; g.fill(); g.lineWidth = 3; g.strokeStyle = "#000"; g.stroke();
              }
              bar(30, 200, 140, 16, GREY2);
              K.rr(g, 30, 236, TW - 60, 70, 14);
              g.fillStyle = "#FBF8F1"; g.fill(); g.lineWidth = 1.5; g.strokeStyle = "rgba(0,0,0,0.35)"; g.stroke();
              g.beginPath(); g.arc(70, 271, 16, 0, Math.PI * 2); g.fillStyle = "#000"; g.fill();
              bar(102, 262, 220, 18, "rgba(0,0,0,0.6)");
              bar(TW - 150, 262, 90, 18, GREY);
              bar(30, 340, 300, 16);
            } else if (k === 2) {
              // review: rows with checks
              for (let r = 0; r < 4; r++) {
                const y = 104 + r * 64;
                bar(30, y + 12, 130, 16, GREY2);
                bar(190, y + 10, [300, 220, 260, 180][r], 20, "rgba(0,0,0,0.6)");
                g.beginPath(); g.arc(TW - 56, y + 20, 15, 0, Math.PI * 2);
                g.fillStyle = K.C.yes; g.fill();
                g.beginPath(); g.moveTo(TW - 63, y + 20); g.lineTo(TW - 57, y + 26); g.lineTo(TW - 48, y + 13);
                g.lineWidth = 3.5; g.strokeStyle = "#000"; g.lineCap = "round"; g.lineJoin = "round"; g.stroke();
                g.fillStyle = "rgba(0,0,0,0.08)"; g.fillRect(30, y + 50, TW - 60, 1.5);
              }
            } else {
              // live: a mini pool card with a live dot and YES / NO
              K.rr(g, 30, 96, TW - 60, 290, 18);
              g.fillStyle = "#FBF8F1"; g.fill(); g.lineWidth = 1.5; g.strokeStyle = "rgba(0,0,0,0.3)"; g.stroke();
              g.beginPath(); g.arc(66, 132, 10, 0, Math.PI * 2); g.fillStyle = K.C.yes; g.fill();
              g.beginPath(); g.arc(66, 132, 18, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = "rgba(0,0,0,0.5)"; g.stroke();
              bar(96, 122, 120, 18, GREY2);
              bar(56, 170, 420, 26, "rgba(0,0,0,0.8)");
              bar(56, 208, 300, 26, "rgba(0,0,0,0.8)");
              K.rr(g, 56, 268, 262, 80, 14); g.fillStyle = K.C.yes; g.fill();
              g.lineWidth = 2; g.strokeStyle = "#000"; g.stroke();
              K.rr(g, 338, 268, 262, 80, 14); g.fillStyle = K.C.no; g.fill();
              g.font = "800 38px " + K.BR; g.textAlign = "center"; g.textBaseline = "middle";
              g.fillStyle = "#000"; g.fillText("YES", 187, 309);
              g.fillStyle = K.C.light; g.fillText("NO", 469, 309);
            }
            return K.tex(renderer, c);
          }

          const PX = -1.7, PZ = -1.0; // fan pivot: the back-left corner of the deck
          const shadow = K.shadowBlob(6.4, 4.4, 0.2);
          shadow.position.set(0.1, -0.05, 0.1);
          scene.add(shadow);
          const edge = K.edgeMaterial(0xeee8dc);
          const cards = [0, 1, 2, 3].map((k) => {
            const pivot = new THREE.Group();
            const s = K.slab(SW, THK, SD, screen(k), edge, 0.02, 10 + (3 - k));
            s.group.position.set(SW / 2, 0, SD / 2);
            pivot.add(s.group);
            pivot.position.set(PX, 0, PZ);
            scene.add(pivot);
            return pivot;
          });
          const C = K.callouts(ROOT, [
            { idx: "01", name: "MARKET", accent: true },
            { idx: "02", name: "TIMING AND SOURCE" },
            { idx: "03", name: "REVIEW" },
            { idx: "04", name: "LIVE" },
          ], "s29");
          // dashed sweep arc traced by the sheets' outer corner, plus the pivot pin
          const arcPts = [];
          for (let a = -4; a <= 70; a += 2) {
            const r = (a * Math.PI) / 180;
            arcPts.push(new THREE.Vector3(PX + SW * Math.cos(r) + SD * Math.sin(r), 0.004, PZ - SW * Math.sin(r) + SD * Math.cos(r)));
          }
          const arc = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(arcPts),
            new THREE.LineDashedMaterial({ color: 0x000000, transparent: true, opacity: 0, dashSize: 0.08, gapSize: 0.06, depthWrite: false }),
          );
          arc.computeLineDistances();
          scene.add(arc);
          const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.22, 24), K.colorMaterial("#000000", 0.5));
          pin.position.set(PX, 0.1, PZ);
          scene.add(pin);
          const ANG = [63, 42, 21, 0].map((d) => (d * Math.PI) / 180);
          const tmp = new THREE.Vector3();

          function render(t) {
            const drift = K.eInOut(t / DUR);
            cam.place(K.lerp(6, 14, drift), K.lerp(50, 45, drift), [0, 0, -0.5], [1020, 600], K.lerp(1.18, 1.24, drift));
            for (let k = 0; k < 4; k++) {
              const u = K.eOut4(K.seg(t, 0.12 + (3 - k) * 0.05, 0.85));
              const p = cards[k];
              p.rotation.y = ANG[k] * u;
              p.position.y = (3 - k) * THK * 1.15 + Math.sin(K.clamp01(u) * Math.PI) * 0.12 + 0.002;
              p.updateMatrixWorld();
              // anchor: far right corner of the sheet top face
              tmp.set(SW, THK / 2, SD).applyMatrix4(p.matrixWorld);
              const a = cam.toScreen(tmp.x, tmp.y + THK / 2, tmp.z);
              C.place(k, a[0], a[1], 1440, K.eOut(K.seg(t, 0.7 + k * 0.1, 0.3)));
            }
            arc.material.opacity = 0.5 * K.eOut(K.seg(t, 0.35, 0.5));
            renderer.render(scene, cam);
          }
          function tweens(tl) {
            tl.fromTo("#s29-l1", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.1);
            tl.fromTo("#s29-l2", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.2);
          }
          return { render, tweens };
        }
