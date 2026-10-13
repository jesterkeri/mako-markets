        // Shot 19: the exploded layers snap shut; the YES / NO layer stays lifted and lit. Camera: iso left, push in.
        function setup() {
          const renderer = K.makeRenderer(document.getElementById("s19-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const T = K.poolCardTextures(renderer);
          const { w: CW, d: CD } = K.CARD;
          const THICK = 0.16, GAP = 1.0, SHEET = 0.012, N = 5, TOG = 3, LIFT = 2.3;

          const shadow = K.shadowBlob(6.0, 7.2);
          scene.add(shadow);
          const base = K.slab(CW, THICK, CD, T.base, K.edgeMaterial(), 0.05, 10);
          scene.add(base.group);
          const sheets = [T.cta, T.chips, T.toggle, T.question].map((m, k) => {
            const s = K.sheet(CW, CD, m, k + 1);
            scene.add(s.group);
            return s;
          });
          const plates = [base.group, ...sheets.map((s) => s.group)];
          const tog = sheets[TOG - 1];
          tog.face.renderOrder = 22;
          tog.group.children[1].renderOrder = 21;
          // vertical dashed guides from the lifted layer down to the card corners
          const guides = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => {
            const l = K.dashedLine([(sx * CW) / 2, 0, (sz * CD) / 2], [(sx * CW) / 2, 1, (sz * CD) / 2]);
            scene.add(l);
            return l;
          });

          const SHUT_AT = 0.06, SHUT_FOR = 0.42, SHUT_STAGGER = 0.035;

          function render(t) {
            const push = K.eInOut(t / DUR);
            // after the collapse the hold breathes: a slow push in that keeps going to the cut
            const hold = K.eInOut(K.seg(t, 0.35, DUR - 0.35));
            cam.place(K.lerp(-42, -33, push), K.lerp(30, 32, hold), [0, 0.9, 0], [1235, 575], K.lerp(0.9, 1.07, hold));
            const landAt = SHUT_AT + SHUT_FOR + (N - 1) * SHUT_STAGGER;
            const b = K.bump(t, landAt, 0.5, 5);
            let shutAll = 0;
            for (let i = 0; i < N; i++) {
              const exploded = (i - (N - 1) / 2) * GAP + (i === 0 ? -THICK / 2 : i * SHEET);
              const closed = i === 0 ? -THICK / 2 : i * SHEET;
              const u = K.eIn4((t - SHUT_AT - i * SHUT_STAGGER) / SHUT_FOR);
              let y;
              if (i === TOG) {
                // the toggle layer rides up to its lifted spot and floats there
                y = K.lerp(exploded, LIFT, K.eOut(K.seg(t, 0.1, 0.55))) + Math.sin(K.clamp01((t - 0.65) / (DUR - 0.65)) * Math.PI) * 0.06;
              } else {
                y = K.lerp(exploded, closed, u) + b * 0.06 * (i === 0 ? 0.4 : 1);
                shutAll = Math.max(shutAll, 0);
              }
              plates[i].position.y = y;
              if (i === 0) shadow.position.y = y - THICK / 2 - 0.5 - (1 - u) * 0.2;
            }
            const shut = K.eIn4((t - SHUT_AT - (N - 1) * SHUT_STAGGER) / SHUT_FOR);
            sheets.forEach((s, k) => {
              const isTog = k === TOG - 1;
              s.frame.opacity = isTog ? 0.7 : 0.55 * (1 - shut);
              s.acetate.opacity = isTog ? 0.0 : 0.16 * (1 - shut);
            });
            // highlight: warm yellow acetate under the lifted layer
            const hi = K.eOut(K.seg(t, 0.45, 0.35));
            tog.acetate.color.setStyle("#FACC15");
            tog.acetate.opacity = 0.07 + 0.09 * hi;
            const gy = plates[TOG].position.y;
            guides.forEach((g) => {
              g.scale.y = Math.max(0.001, gy);
              g.material.opacity = 0.5 * hi;
              g.material.dashSize = 0.07 / Math.max(0.2, gy);
              g.material.gapSize = 0.05 / Math.max(0.2, gy);
            });
            renderer.render(scene, cam);
          }
          function tweens(tl) {
            tl.fromTo("#s19-l1", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.1);
            tl.fromTo("#s19-l2", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.2);
          }
          return { render, tweens };
        }
