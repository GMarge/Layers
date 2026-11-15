import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { Point } from './useSpringPosition';

export type Shape = 'drop' | 'ghost' | 'bean' | 'sheet' | 'tile';
export type Mood = 'idle' | 'checking' | 'alert' | 'found' | 'waiting' | 'working' | 'happy';

/** out: a floating character. in: melted into the chat box, eyes showing. gone: fully hidden. */
export type Presence = 'out' | 'in' | 'gone';
/** plucked: pulled straight out of the chat box by a drag, with no time to rise. */
type Phase = Presence | 'sinking' | 'rising' | 'plucked';

/**
 * Silhouettes on a 64 x 64 grid. To change the character, edit or add an entry:
 * `d` is the body, `eyeY` is where the eyes sit, `fold` is an optional darker detail.
 */
export const SHAPES: Record<Shape, { name: string; d: string; eyeY: number; fold?: string }> = {
  drop: { name: 'Drop', d: 'M32 5C36 13 56 25 56 38A24 24 0 0 1 8 38C8 25 28 13 32 5Z', eyeY: 39 },
  ghost: {
    name: 'Ghost',
    d: 'M10 30A22 22 0 0 1 54 30V54q-5.5 6-11 0q-5.5 6-11 0q-5.5 6-11 0q-5.5 6-11 0Z',
    eyeY: 30,
  },
  bean: {
    name: 'Bean',
    d: 'M22 8h14a16 16 0 0 1 16 16v14a20 20 0 0 1-20 20h-2a18 18 0 0 1-18-18V22a14 14 0 0 1 10-14Z',
    eyeY: 30,
  },
  sheet: {
    name: 'Sheet',
    d: 'M20 8h18l18 18v18a12 12 0 0 1-12 12H20A12 12 0 0 1 8 44V20A12 12 0 0 1 20 8Z',
    eyeY: 37,
    fold: 'M38 8v12a6 6 0 0 0 6 6h12Z',
  },
  tile: {
    name: 'Tile',
    d: 'M21 7h22a15 15 0 0 1 15 15v20a15 15 0 0 1-15 15H21A15 15 0 0 1 6 42V22A15 15 0 0 1 21 7Z',
    eyeY: 32,
  },
};

/** The layers behind the body, back to front, in the order they sit in the logo. */
const UNDER = ['var(--layer-orange)', 'var(--layer-red)', 'var(--layer-pink)'];

/** A press that travels less than this is a tap, however shaky the hand. */
const TAP_SLOP = 9;

const SINK_MS = 800;
const PLUCK_MS = 380;
/** Height of the eyes, in the mascot's 64px box, while they sit on the chat box. */
const NIB_EYE_Y = 71.5;

/** Small still version of a silhouette, for pickers. */
export function MascotGlyph({ shape }: { shape: Shape }) {
  const s = SHAPES[shape];
  return (
    <svg className="glyph" viewBox="0 0 64 64" aria-hidden="true">
      <path className="mascot__body" d={s.d} />
      {s.fold && <path className="mascot__fold" d={s.fold} />}
      <ellipse cx="25" cy={s.eyeY} rx="4" ry="6" />
      <ellipse cx="39" cy={s.eyeY} rx="4" ry="6" />
    </svg>
  );
}

interface Props {
  shape: Shape;
  mood: Mood;
  /** Increment to play a single nod. */
  nod: number;
  followPointer: boolean;
  presence: Presence;
  /** True while the droplet is forming out of the chat box. Driven by the cluster so both stay in step. */
  rising: boolean;
  reducedMotion: boolean;
  grabbed: boolean;
  /** Being held over the chat box, where letting go tucks it in. */
  over: boolean;
  draggable: boolean;
  label: string;
  onClick: () => void;
  /** Positions are where the mascot's centre should be, in viewport pixels. */
  onDrag: (centre: Point) => void;
  onDrop: (centre: Point) => void;
}

export function Mascot(props: Props) {
  const { shape, mood, nod, followPointer, presence, reducedMotion, grabbed, draggable, label } = props;
  const ref = useRef<HTMLButtonElement>(null);
  const press = useRef<{ id: number; x: number; y: number; dx: number; dy: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);

  // Melting into the chat box and forming out of it are played as their own phases,
  // so the liquid animation always runs start to finish.
  const [phase, setPhase] = useState<Phase>(presence);
  const risingRef = useRef(props.rising);
  risingRef.current = props.rising;
  const settled = useRef(presence);
  useEffect(() => {
    const from = settled.current;
    settled.current = presence;
    if (from === presence) {
      // A motion-preference change must not leave an interrupted melt frozen.
      if (reducedMotion) setPhase(presence);
      return;
    }
    if (reducedMotion) {
      setPhase(presence);
      return;
    }
    if (from !== 'out') {
      if (presence !== 'out' || risingRef.current) {
        setPhase(presence);
        return;
      }
      // Dragged out of the box: grow into shape under the pointer, then let the layers fall out.
      setPhase('plucked');
      const timer = setTimeout(() => setPhase('out'), PLUCK_MS);
      return () => clearTimeout(timer);
    }
    setPhase('sinking');
    const timer = setTimeout(() => setPhase(presence), SINK_MS);
    return () => clearTimeout(timer);
  }, [presence, reducedMotion]);
  const shown: Phase = props.rising ? 'rising' : phase;

  // Resting eyes drift toward the pointer. Everywhere else the mood sets the gaze.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!followPointer) {
      el.style.setProperty('--ptr-x', '0');
      el.style.setProperty('--ptr-y', '0');
      return;
    }
    let frame = 0;
    let px = 0;
    let py = 0;
    const apply = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2);
      const dy = py - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, dist / 260);
      el.style.setProperty('--ptr-x', ((dx / dist) * 2.6 * reach).toFixed(2));
      el.style.setProperty('--ptr-y', ((dy / dist) * 2.2 * reach).toFixed(2));
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX;
      py = e.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, [followPointer]);

  // The drag listens on the whole window, not just the agent, so letting go is never missed:
  // not when the pointer outruns him, not when he changes shape under it.
  const live = useRef({ onDrag: props.onDrag, onDrop: props.onDrop });
  live.current = { onDrag: props.onDrag, onDrop: props.onDrop };
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!draggable || e.button !== 0) return;
    stopDrag.current?.();
    const r = e.currentTarget.getBoundingClientRect();
    const p = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      dx: e.clientX - (r.left + r.width / 2),
      dy: e.clientY - (r.top + r.height / 2),
      dragging: false,
    };
    press.current = p;

    const finish = (x: number, y: number) => {
      stop();
      if (!p.dragging) return;
      suppressClick.current = true;
      // A click can follow a drag. Stop swallowing it shortly after, in case none comes.
      setTimeout(() => (suppressClick.current = false), 250);
      live.current.onDrop({ x: x - p.dx, y: y - p.dy });
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== p.id) return;
      // The button is no longer down: the release happened somewhere it could not be seen.
      if (ev.pointerType === 'mouse' && ev.buttons === 0) {
        finish(ev.clientX, ev.clientY);
        return;
      }
      if (!p.dragging && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < TAP_SLOP) return;
      p.dragging = true;
      live.current.onDrag({ x: ev.clientX - p.dx, y: ev.clientY - p.dy });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === p.id) finish(ev.clientX, ev.clientY);
    };
    const onLeave = () => finish(p.x, p.y);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') finish(p.x, p.y);
    };
    const stop = () => {
      press.current = null;
      stopDrag.current = null;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', onLeave);
      window.removeEventListener('keydown', onKey, true);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', onLeave);
    window.addEventListener('keydown', onKey, true);
    stopDrag.current = stop;
  };

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    props.onClick();
  };

  const s = SHAPES[shape];

  return (
    <button
      ref={ref}
      type="button"
      className="mascot"
      data-mood={mood}
      data-phase={shown}
      data-grab={grabbed ? '' : undefined}
      data-over={props.over ? '' : undefined}
      style={{ '--eye-lift': `${s.eyeY - NIB_EYE_Y}px` } as CSSProperties}
      aria-label={label}
      aria-hidden={shown === 'gone' ? true : undefined}
      tabIndex={shown === 'gone' ? -1 : undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      {/* Liquid layer: a pool on the edge of the chat box and a blob that merges with it.
          The filter fuses the two so they pull together like surface tension. */}
      <span className="goo" aria-hidden="true">
        <span className="goo__pool" />
        <svg className="goo__blob" viewBox="0 0 64 64">
          <path d={s.d} />
        </svg>
      </span>

      <span className="mascot__fly">
        <span className="mascot__bob">
          <span className="mascot__nod" key={nod} data-play={nod > 0 ? '' : undefined}>
            <span className="mascot__melt">
              <svg className="mascot__svg" viewBox="0 0 64 64" aria-hidden="true">
                {UNDER.map((fill, n) => (
                  <path
                    key={fill}
                    className="mascot__layer"
                    d={s.d}
                    fill={fill}
                    style={{ '--i': UNDER.length - n } as CSSProperties}
                  />
                ))}
                <path className="mascot__body" d={s.d} />
                {s.fold && <path className="mascot__fold" d={s.fold} />}
                <g className="mascot__eyes">
                  <g className="mascot__glance">
                    <ellipse className="mascot__eye" cx="25" cy={s.eyeY} rx="4" ry="6" />
                    <ellipse className="mascot__eye mascot__eye--right" cx="39" cy={s.eyeY} rx="4" ry="6" />
                    <path className="mascot__smile" d={`M21 ${s.eyeY + 1.8}q4-5.6 8 0`} />
                    <path className="mascot__smile" d={`M35 ${s.eyeY + 1.8}q4-5.6 8 0`} />
                  </g>
                </g>
              </svg>
            </span>
          </span>
        </span>
      </span>

      {/* The eyes that ride the liquid down and stay showing on the chat box. */}
      <span className="nib-hit" aria-hidden="true" />
      <span className="nib-eyes" aria-hidden="true">
        <i />
        <i />
      </span>

      <svg className="goo-defs" width="0" height="0" aria-hidden="true">
        <filter id="layers-goo" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="4" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -7" />
        </filter>
      </svg>
    </button>
  );
}
