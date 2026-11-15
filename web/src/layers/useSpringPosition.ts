import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface Point {
  x: number;
  y: number;
}

// Slightly under-damped so the agent settles without a visible bounce.
// The vertical axis is a little stiffer, which bends long flights into an arc.
const KX = 110;
const CX = 19.5;
const KY = 150;
const CY = 22.5;

/** The bubble may open only when the character has nearly finished moving. */
const NEAR = 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Moves `ref` toward `target` on a damped spring and writes the motion out as
 * CSS variables (--lean, --stretch, --fly-x, --fly-y) for the mascot to react to.
 * Retargeting mid-flight keeps the current velocity, so the motion is interruptible.
 *
 * Returns false while the agent is in flight to a new place.
 */
export function useSpringPosition(ref: RefObject<HTMLElement | null>, target: Point, reduced: boolean): boolean {
  const [arrived, setArrived] = useState(true);
  const state = useRef({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, raf: 0, timer: 0, last: 0, placed: false });

  useLayoutEffect(() => {
    const s = state.current;
    const el = ref.current;
    if (!el) return;
    s.tx = target.x;
    s.ty = target.y;

    const write = () => {
      el.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`;
      el.style.setProperty('--lean', clamp(s.vx * 0.008, -13, 13).toFixed(2));
      el.style.setProperty('--stretch', clamp(Math.hypot(s.vx, s.vy) / 14000, 0, 0.1).toFixed(3));
      el.style.setProperty('--fly-x', clamp(s.vx / 420, -2.6, 2.6).toFixed(2));
      el.style.setProperty('--fly-y', clamp(s.vy / 420, -2, 2).toFixed(2));
    };

    const settle = () => {
      cancelAnimationFrame(s.raf);
      clearTimeout(s.timer);
      s.raf = 0;
      s.x = s.tx;
      s.y = s.ty;
      s.vx = 0;
      s.vy = 0;
      write();
      setArrived(true);
    };

    if (!s.placed || reduced) {
      s.placed = true;
      settle();
      return;
    }

    // A 34px early-arrival window made the bubble pop while the mascot was
    // still moving, particularly after short repositions around the composer.
    if (Math.hypot(s.x - s.tx, s.y - s.ty) > NEAR) setArrived(false);
    // Browsers pause animation frames in a background tab. Land anyway so the bubble still opens.
    clearTimeout(s.timer);
    s.timer = window.setTimeout(settle, 1400);
    if (s.raf) return; // already flying: the running loop picks up the new target

    s.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - s.last) / 1000, 1 / 30);
      s.last = now;
      s.vx += (-KX * (s.x - s.tx) - CX * s.vx) * dt;
      s.vy += (-KY * (s.y - s.ty) - CY * s.vy) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      const dist = Math.hypot(s.x - s.tx, s.y - s.ty);
      if (dist < NEAR && Math.hypot(s.vx, s.vy) < 25) setArrived(true);
      if (dist < 0.3 && Math.hypot(s.vx, s.vy) < 6) {
        settle();
        return;
      }
      write();
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  }, [ref, target.x, target.y, reduced]);

  useEffect(() => {
    const s = state.current;
    return () => {
      cancelAnimationFrame(s.raf);
      clearTimeout(s.timer);
      s.raf = 0;
    };
  }, []);

  return arrived;
}
