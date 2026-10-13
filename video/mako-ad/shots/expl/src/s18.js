        // Shot 18: the pool card explodes into five labelled layers. Camera: iso right, slow orbit.
        function setup() {

          const renderer = K.makeRenderer(document.getElementById("s18-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const T = K.poolCardTextures(renderer);
          const { w: CW, d: CD } = K.CARD;
          const THICK = 0.16, GAP = 1.0, SHEET = 0.012, N = 5;

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

          // callouts, numbered top-down: layer index i (0 = base) -> label
          const C = K.callouts(ROOT, [
            { idx: "05", name: "CARD" },
            { idx: "04", name: "CONFIRM" },
            { idx: "03", name: "AMOUNT" },
            { idx: "02", name: "YES / NO", accent: true },
            { idx: "01", name: "QUESTION" },
          ], "s18");

          const OPEN_AT = 0.1, OPEN_FOR = 0.85, OPEN_STAGGER = 0.06;
          const LAND_AT = 0.45, LAND_EVERY = 0.1, DRAW = 0.28;
          const COL = 1370;
          const corners = [[1, -1], [1, 1], [-1, 1], [-1, -1]];

          function render(t) {
            const orbit = K.eInOut(t / DUR);
            cam.place(K.lerp(36, 47, orbit), 33, [0, 0.15, 0], [850, 530], K.lerp(0.96, 1.01, orbit));
            let topOpen = 0;
            for (let i = 0; i < N; i++) {
              const order = N - 1 - i; // top sheet leaves first
              const o = K.eOpen((t - OPEN_AT - order * OPEN_STAGGER) / OPEN_FOR);
              if (i === N - 1) topOpen = o;
              const settle = K.bump(t, OPEN_AT + order * OPEN_STAGGER + OPEN_FOR * 0.75, 0.5, 6) * 0.05 * (i - 2);
              const y = (i - (N - 1) / 2) * o * GAP + (i === 0 ? -THICK / 2 : i * SHEET) + settle;
              plates[i].position.y = y;
              if (i === 0) shadow.position.y = y - THICK / 2 - 0.5 - o * 0.2;
              // anchor: right-most screen corner of the layer
              let best = null;
              const ay = y + (i === 0 ? THICK / 2 : 0);
              for (const [sx, sz] of corners) {
                const p = cam.toScreen((sx * CW) / 2, ay, (sz * CD) / 2);
                if (!best || p[0] > best[0]) best = p;
              }
              const shown = K.eOut((t - LAND_AT - order * LAND_EVERY) / DRAW);
              C.place(i, best[0], best[1], COL, shown);
            }
            for (const s of sheets) {
              s.frame.opacity = 0.55 * topOpen;
              s.acetate.opacity = 0.16 * topOpen;
            }
            renderer.render(scene, cam);
          }
          return { render };
        }
