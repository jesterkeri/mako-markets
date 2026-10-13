        // Shot 21: the amount layer lifts off the card; the 0.10 chip rises out of it and turns yellow. Camera: plan oblique.
        function setup() {

          const renderer = K.makeRenderer(document.getElementById("s21-canvas"));
          const scene = K.makeScene();
          const cam = K.makeCamera(4.5);
          const T = K.poolCardTextures(renderer, { skipChip: 0 });
          const { w: CW, d: CD, tw: TW, th: TH } = K.CARD;
          const THICK = 0.16, SHEET = 0.012;

          const shadow = K.shadowBlob(6.0, 7.2);
          shadow.position.y = -THICK - 0.3;
          scene.add(shadow);
          const base = K.slab(CW, THICK, CD, T.base, K.edgeMaterial(), 0.05, 10);
          base.group.position.y = -THICK / 2;
          scene.add(base.group);
          const layers = [T.cta, T.chips, T.toggle, T.question].map((m, k) => {
            const s = K.sheet(CW, CD, m, k + 1);
            s.group.position.y = (k + 1) * SHEET;
            scene.add(s.group);
            return s;
          });
          const chipsL = layers[1];
          chipsL.face.renderOrder = 22;
          chipsL.group.children[1].renderOrder = 21;

          // the 0.10 chip as its own little slab, positioned from its texture rect
          const [rx, ry, rw, rh] = T.chipRect(0);
          const cw = (rw / TW) * CW, cd = (rh / TH) * CD;
          const cx = ((rx + rw / 2) / TW) * CW - CW / 2, cz = ((ry + rh / 2) / TH) * CD - CD / 2;
          const chipFace = (yellow) => {
            const [c, g] = K.canvas2d(360, 264);
            K.rr(g, 0, 0, 360, 264, 52);
            g.fillStyle = yellow ? K.C.yes : K.C.chip;
            g.fill();
            g.lineWidth = 5;
            g.strokeStyle = yellow ? "#000" : "rgba(0,0,0,0.35)";
            K.rr(g, 2.5, 2.5, 355, 259, 50);
            g.stroke();
            g.fillStyle = "#000";
            g.font = (yellow ? "700 " : "600 ") + "100px " + K.MO;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText("0.10", 180, 138);
            return K.tex(renderer, c);
          };
          const chip = new THREE.Group();
          const chipBodyMat = K.colorMaterial("#F3EEE3", 0.7);
          const body = new THREE.Mesh(new K.RoundedBoxGeometry(cw, 0.07, cd, 4, 0.03), chipBodyMat);
          chip.add(body);
          const faceW = new THREE.Mesh(new THREE.PlaneGeometry(cw, cd), new THREE.MeshBasicMaterial({ map: chipFace(false), transparent: true }));
          const faceY = new THREE.Mesh(new THREE.PlaneGeometry(cw, cd), new THREE.MeshBasicMaterial({ map: chipFace(true), transparent: true, opacity: 0 }));
          for (const [f, o] of [[faceW, 0.036], [faceY, 0.037]]) {
            f.rotation.x = -Math.PI / 2;
            f.position.y = o;
            f.renderOrder = 30;
            chip.add(f);
          }
          scene.add(chip);
          // ghost slot where the chip came from, and a dashed rise guide
          const slot = K.dashedRect(cw, cd, 0.04, 0.03);
          scene.add(slot);
          const guide = K.dashedLine([cx, 0, cz], [cx, 1, cz]);
          scene.add(guide);
          const yellowBody = new THREE.Color().setStyle(K.C.yes);
          const paperBody = new THREE.Color().setStyle("#F3EEE3");

          function render(t) {
            const drift = K.eInOut(t / DUR);
            cam.place(K.lerp(22, 30, drift), 27, [0, K.lerp(0.15, 1.2, K.eInOut(K.seg(t, 0, 0.8))), 0.5], [1320, 600], K.lerp(1.36, 1.44, drift));
            const lift = K.eOut(K.seg(t, 0.05, 0.5)) + K.bump(t, 0.5, 0.4, 6) * 0.05;
            const ly = 2 * SHEET + lift * 2.1;
            const lx = 0, lz = lift * 0.5;
            chipsL.group.position.set(lx, ly, lz);
            chipsL.frame.opacity = 0.6 * Math.min(1, lift * 1.5);
            chipsL.acetate.opacity = 0.14 * Math.min(1, lift * 1.5);
            const rise = K.eBack(K.seg(t, 0.42, 0.45));
            const cy = ly + 0.035 + rise * 0.75;
            const sc = 1 + 1.15 * rise;
            chip.position.set(lx + cx + rise * 0.5, cy, lz + cz + rise * 0.2);
            chip.scale.set(sc, sc, sc);
            chip.rotation.y = -0.12 * rise;
            const yel = K.eOut(K.seg(t, 0.62, 0.25));
            faceY.material.opacity = yel;
            chipBodyMat.color.copy(paperBody).lerp(yellowBody, yel);
            slot.position.set(lx + cx, ly + 0.002, lz + cz);
            slot.material.opacity = 0.7 * K.clamp01(rise * 3);
            guide.position.set(0, ly, 0);
            const gl = Math.max(0.001, cy - ly);
            guide.scale.y = gl;
            guide.position.x = 0;
            guide.geometry.attributes.position.setXYZ(0, lx + cx, 0, lz + cz);
            guide.geometry.attributes.position.setXYZ(1, chip.position.x, 1, chip.position.z);
            guide.geometry.attributes.position.needsUpdate = true;
            guide.computeLineDistances();
            guide.material.dashSize = 0.06 / gl;
            guide.material.gapSize = 0.045 / gl;
            guide.material.opacity = 0.55 * K.clamp01(rise * 3);
            renderer.render(scene, cam);
          }
          function tweens(tl) {
            tl.fromTo("#s21-l1", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.08);
            tl.fromTo("#s21-l2", { yPercent: 130 }, { yPercent: 0, duration: 0.55, ease: "power3.out" }, 0.18);
          }
          return { render, tweens };
        }
