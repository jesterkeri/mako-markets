import { useLayoutEffect, useRef } from "react";

import { cursorAt, UserCursor } from "../kit/cursor";

/**
 * The user's cursor (kit/cursor.tsx), aimed at a live-measured target. Positions come from the DOM each frame
 * (measure, never guess), so camera moves and 3D planes cannot leave it off target. Pure: the same t gives the
 * same layout, so the same point. Must sit directly inside the full-frame root: two markers at (0,0) and (1000,0)
 * give the frame's origin and scale on the page (the render page is offset, the Studio preview is scaled).
 * Caveat (found in review): at first-mount layout time the root can still be 0 px wide, so targets must be laid
 * out from left/top in px, never right/bottom/percent.
 */
export function MeasuredCursor({ t, selector, from, arriveAt, leaveAt, anchor = { x: 0.82, y: 0.72 }, size = 1.35 }: { t: number; selector: string; from: { x: number; y: number; t: number }; arriveAt: number; leaveAt?: number; anchor?: { x: number; y: number }; size?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const o = useRef<HTMLDivElement>(null);
  const u = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scope = ref.current?.parentElement;
    const a = o.current?.getBoundingClientRect();
    const b = u.current?.getBoundingClientRect();
    const el = scope?.querySelector(selector)?.getBoundingClientRect();
    if (!a || !b || !el || !ref.current) return;
    const k = (b.x - a.x) / 1000;
    const target = { x: (el.x - a.x + el.width * anchor.x) / k, y: (el.y - a.y + el.height * anchor.y) / k };
    const c = cursorAt(t, [from, { t: arriveAt, x: target.x, y: target.y, click: true }], (x, y) => ({ x, y }));
    ref.current.style.translate = `${c.x}px ${c.y}px`;
    const svg = ref.current.querySelector("svg");
    if (svg) svg.style.scale = String(c.squash);
  });
  const visible = t >= from.t - 0.05 && (leaveAt === undefined || t < leaveAt);
  return (
    <>
      <div ref={o} style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0 }} />
      <div ref={u} style={{ position: "absolute", left: 1000, top: 0, width: 0, height: 0 }} />
      <div ref={ref} style={{ position: "absolute", left: 0, top: 0, translate: "-300px -300px", visibility: visible ? "visible" : "hidden" }}>
        <div style={{ scale: String(size), transformOrigin: "0 0" }}>
          <UserCursor x={0} y={0} squash={1} />
        </div>
      </div>
    </>
  );
}
