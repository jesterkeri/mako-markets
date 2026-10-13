        // Shot 25: pool diagram. YES and NO stacks of layered slabs; two thin fee slices peel off the end.
        // Only numbers on screen: the two fee callouts. Camera: low three-quarter from the right.
        function setup() {

          const renderer = K.makeRenderer(document.getElementById("s25-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const fill = new THREE.DirectionalLight(0xffffff, 0.9);
          fill.position.set(8, 5, 2);
          scene.add(fill);
          const LEN = 3.4, DEP = 1.7, GAPZ = 0.22, N = 6, SL = 0.15;
          const FA = 0.05, FB = 0.1; // slice thickness along x: 1% and 2%
          const yesM = K.colorMaterial(K.C.yes, 0.55);
          const noM = K.colorMaterial(K.C.no, 0.55);
          const zYes = -(DEP + GAPZ) / 2, zNo = (DEP + GAPZ) / 2;
          const bodyLen = LEN - FA - FB;
          const x0 = -LEN / 2; // block starts here, slices sit at the +x end

          const shadow = K.shadowBlob(7.5, 6.0, 0.3);
          shadow.position.y = -0.04;
          scene.add(shadow);
          // tray
          const tray = K.slab(LEN + 0.7, 0.06, DEP * 2 + GAPZ + 0.7, null, K.edgeMaterial(0xe6e0d2), 0.03);
          tray.group.position.set(0, -0.03, 0);
          scene.add(tray.group);
          const trayLine = K.dashedRect(LEN + 0.7, DEP * 2 + GAPZ + 0.7);
          trayLine.position.y = 0.002;
          scene.add(trayLine);

          // a stack of N slabs of length `len`, as one group per layer so the gaps can open
          function stack(len, mat, z) {
            const layers = [];
            for (let i = 0; i < N; i++) {
              const m = new THREE.Mesh(new K.RoundedBoxGeometry(len, SL, DEP, 3, Math.min(0.03, len / 2 - 0.001)), mat);
              m.position.z = z;
              scene.add(m);
              layers.push(m);
            }
            return layers;
          }
          const bodyYes = stack(bodyLen, yesM, zYes);
          const bodyNo = stack(bodyLen, noM, zNo);
          // slices: each is a group (YES part + NO part) pivoting on its bottom outer edge
          function slice(th) {
            const pivot = new THREE.Group();
            const inner = new THREE.Group();
            pivot.add(inner);
            const plate = (mat, z) => {
              const m = new THREE.Mesh(new K.RoundedBoxGeometry(th, 1, DEP, 2, Math.min(0.02, th / 2 - 0.001)), mat);
              m.position.set(-th / 2, 0, z);
              inner.add(m);
              return m;
            };
            const ys = [plate(yesM, zYes)], ns = [plate(noM, zNo)];
            scene.add(pivot);
            return { pivot, inner, ys, ns };
          }
          const sB = slice(FB); // 2% host, inner slice
          const sA = slice(FA); // 1% Mako Market, outer slice
          const ghostA = K.dashedBox(FA, 1, DEP * 2 + GAPZ);
          const ghostB = K.dashedBox(FB, 1, DEP * 2 + GAPZ);
          scene.add(ghostA, ghostB);

          const C = K.callouts(ROOT, [
            { idx: "1%", name: "Mako Market", cls: "xp-case" },
            { idx: "2%", name: "host", cls: "xp-case" },
          ], "s25");

          const yOf = (i, gap) => SL / 2 + i * (SL + gap);
          function render(t) {
            const drift = K.eInOut(t / DUR);
            cam.place(K.lerp(50, 44, drift), K.lerp(23, 27, drift), [0.9, 0.55, 0], [860, 600], K.lerp(1.1, 1.16, drift));
            const gap = 0.012 + 0.05 * K.eOut(K.seg(t, 0.0, 0.45));
            const H = yOf(N - 1, gap) + SL / 2;
            const lay = (arr, xc) => arr.forEach((m, i) => { m.position.x = xc; m.position.y = yOf(i, gap); });
            lay(bodyYes, x0 + bodyLen / 2);
            lay(bodyNo, x0 + bodyLen / 2);
            const xB0 = x0 + bodyLen, xA0 = xB0 + FB;
            // solid slices span the full stack height
            for (const sl of [sA, sB]) for (const m of [...sl.ys, ...sl.ns]) { m.scale.y = H; m.position.y = H / 2; }
            const pB = K.eOut4(K.seg(t, 0.26, 0.6)), pA = K.eOut4(K.seg(t, 0.32, 0.62));
            // peel: slide out along +x, lift, and lean away from the block (pivot on the bottom outer edge)
            sB.pivot.position.set(xB0 + FB + pB * 1.0, pB * 0.12, 0);
            sB.pivot.rotation.z = -0.12 * pB;
            sA.pivot.position.set(xA0 + FA + pA * 2.1, pA * 0.34, 0);
            sA.pivot.rotation.z = -0.24 * pA;
            ghostB.position.set(xB0 + FB / 2, H / 2, 0);
            ghostB.scale.y = H;
            ghostA.position.set(xA0 + FA / 2, H / 2, 0);
            ghostA.scale.y = H;
            ghostA.material.opacity = 0.55 * K.clamp01(pA * 4);
            ghostB.material.opacity = 0.55 * K.clamp01(pB * 4);
            trayLine.material.opacity = 0.35;
            // callout anchors: top outer corner of each slice (A at the back, B at the front)
            const tmp = new THREE.Vector3();
            sA.pivot.updateMatrixWorld();
            sB.pivot.updateMatrixWorld();
            tmp.set(0, H, -(DEP + GAPZ / 2)).applyMatrix4(sA.pivot.matrixWorld);
            const a = cam.toScreen(tmp.x, tmp.y, tmp.z);
            tmp.set(0, 0, DEP + GAPZ / 2).applyMatrix4(sB.pivot.matrixWorld);
            const b = cam.toScreen(tmp.x, tmp.y, tmp.z);
            const COL = 1420;
            C.place(0, a[0], a[1], COL, K.eOut(K.seg(t, 0.62, 0.3)));
            C.place(1, b[0], b[1], COL, K.eOut(K.seg(t, 0.72, 0.3)));
            renderer.render(scene, cam);
          }
          return { render };
        }
