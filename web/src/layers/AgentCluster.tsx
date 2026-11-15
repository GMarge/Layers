import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../ui/useMediaQuery';
import { Bubble, isCompact, type BubbleActions, type BubblePlacement, type Prefs } from './Bubble';
import { Mascot, type Mood, type Presence, type Shape } from './Mascot';
import type { Counters, Placement, RestMode, Scene } from './types';
import { useSpringPosition, type Point } from './useSpringPosition';

const HALF = 32; // half the mascot's size
const DOCK = 58; // distance from the corner to the mascot's centre when floating with no chosen spot
const GAP = 14; // space between the mascot and the composer it speaks from
const HOME_KEY = 'layers.home';
const EMERGE_MS = 900; // how long the droplet takes to form before the agent lifts off

/**
 * Where the agent is headed:
 * - drag: under the employee's pointer
 * - composer: hovering over the chat box, where it always speaks from
 * - absorbed: melted into the top edge of the chat box
 * - hidden: gone into the chat box entirely, until called back
 * - home: wherever the employee last left it
 */
type Anchor = 'drag' | 'composer' | 'absorbed' | 'hidden' | 'home';

const MOODS: Record<Scene['name'], Mood> = {
  ambient: 'idle',
  ask: 'found',
  settings: 'found',
  unsure: 'checking',
  checking: 'checking',
  policy: 'alert',
  pending: 'waiting',
  decided: 'idle',
  reuse: 'found',
  working: 'working',
  done: 'happy',
};

/** True while Layers has something on screen that needs the composer lane. */
function isSpeaking(scene: Scene): boolean {
  if (scene.name === 'ambient') return false;
  if (scene.name === 'checking') return scene.engaged;
  return true;
}

const composerRect = () => document.getElementById('composer')?.getBoundingClientRect() ?? null;

const clampToView = (p: Point): Point => ({
  x: Math.min(window.innerWidth - HALF - 8, Math.max(HALF + 8, p.x)),
  y: Math.min(window.innerHeight - HALF - 8, Math.max(HALF + 8, p.y)),
});

/** Default floating spot: the bottom right corner, or above the composer when the corner is taken. */
function dockPoint(): Point {
  const corner = { x: window.innerWidth - DOCK, y: window.innerHeight - DOCK };
  const r = composerRect();
  if (!r || r.right + 20 < corner.x - HALF) return corner;
  return { x: Math.round(r.right - 34), y: Math.round(r.top - HALF - GAP) };
}

/** Speaking spot: over the top left of the chat box, never on top of the text. */
function composerPoint(): Point {
  const r = composerRect();
  if (!r) return dockPoint();
  return { x: Math.round(r.left + 40), y: Math.round(r.top - HALF - GAP) };
}

/** Resting in the chat box and speaking from it are the same spot: only the liquid moves. */
const absorbedPoint = composerPoint;

function loadHome(): Point | null {
  try {
    const raw = localStorage.getItem(HOME_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Point>) : null;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

function saveHome(p: Point) {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify(p));
  } catch {
    // Private windows can refuse storage. The spot just won't be remembered.
  }
}

interface Props {
  scene: Scene;
  placement: Placement;
  shape: Shape;
  rest: RestMode;
  reducedMotion: boolean;
  nod: number;
  counters: Counters;
  hasDraft: boolean;
  prefs: Prefs;
  actions: BubbleActions;
  onMascotClick: () => void;
  onRestChange: (rest: RestMode) => void;
  /** Reports whether the agent is currently melted into the chat box. */
  onAbsorbedChange: (absorbed: boolean) => void;
  /** Reports how much room above the composer Layers needs, so the chat can make way. */
  onReserveChange: (px: number) => void;
}

export function AgentCluster(props: Props) {
  const { scene, placement, rest, reducedMotion } = props;
  const clusterRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery('(max-width: 640px)');

  const [drag, setDrag] = useState<Point | null>(null);
  const [home, setHome] = useState<Point | null>(loadHome);

  const speaking = isSpeaking(scene);
  const anchor: Anchor = drag
    ? 'drag'
    : speaking
      ? 'composer'
      : rest === 'absorbed'
        ? 'absorbed'
        : rest === 'hidden'
          ? 'hidden'
          : 'home';
  const place: BubblePlacement = narrow ? 'above' : placement;

  // Coming out of the chat box, the bubble waits until the droplet has fully formed.
  const inBox = anchor === 'absorbed' || anchor === 'hidden';
  const wasInBox = useRef(inBox);
  const [emerging, setEmerging] = useState(false);
  useLayoutEffect(() => {
    const leaving = wasInBox.current && !inBox && anchor !== 'drag';
    wasInBox.current = inBox;
    if (!leaving || reducedMotion) return;
    setEmerging(true);
    const timer = setTimeout(() => setEmerging(false), EMERGE_MS);
    return () => {
      clearTimeout(timer);
      setEmerging(false);
    };
  }, [inBox, anchor, reducedMotion]);

  const [target, setTarget] = useState<Point>(dockPoint);
  const arrived = useSpringPosition(clusterRef, target, reducedMotion || anchor === 'drag');

  const onReserve = useRef(props.onReserveChange);
  onReserve.current = props.onReserveChange;

  // Keep the target glued to the chat box as the layout around it changes,
  // and tell the chat how much room to leave so nothing is covered.
  useLayoutEffect(() => {
    const compute = () => {
      const bubbleHeight = bubbleRef.current?.offsetHeight ?? 0;
      let next: Point;
      if (anchor === 'drag' && drag) next = drag;
      else if (anchor === 'composer') next = composerPoint();
      else if (anchor === 'absorbed' || anchor === 'hidden') next = absorbedPoint();
      else next = home ? clampToView(home) : dockPoint();
      setTarget((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));

      let reserve = 0;
      if (anchor === 'composer') {
        reserve = place === 'above' ? bubbleHeight + 2 * HALF + 50 : Math.max(bubbleHeight + 24, 2 * HALF + 30);
      } else if (anchor === 'home' && !home) {
        reserve = 56;
      }
      onReserve.current(reserve);
    };
    compute();
    const observer = new ResizeObserver(compute);
    const composer = document.getElementById('composer');
    if (composer) observer.observe(composer);
    if (bubbleRef.current) observer.observe(bubbleRef.current);
    window.addEventListener('resize', compute);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [anchor, place, drag, home, arrived, emerging, scene.name]);

  const presence: Presence =
    arrived && anchor === 'absorbed' ? 'in' : arrived && anchor === 'hidden' ? 'gone' : 'out';
  // The chat box keeps its outline until the droplet has left it.
  const absorbed = presence === 'in' || emerging;
  const onAbsorbed = useRef(props.onAbsorbedChange);
  onAbsorbed.current = props.onAbsorbedChange;
  useEffect(() => onAbsorbed.current(absorbed), [absorbed]);

  /** Dropping the agent on the chat box tucks it in. Anywhere else becomes its new spot. */
  const onDrop = (centre: Point) => {
    setDrag(null);
    const r = composerRect();
    const onComposer =
      !!r && centre.x > r.left - 24 && centre.x < r.right + 24 && centre.y > r.top - 44 && centre.y < r.bottom + 24;
    if (onComposer) {
      props.onRestChange('absorbed');
      return;
    }
    const spot = clampToView(centre);
    setHome(spot);
    saveHome(spot);
    props.onRestChange('floating');
  };

  const mood: Mood = scene.name === 'decided' && scene.approved ? 'happy' : MOODS[scene.name];

  return (
    <div className="cluster" ref={clusterRef} data-place={place}>
      <Mascot
        shape={props.shape}
        mood={mood}
        nod={props.nod}
        followPointer={!speaking && !drag}
        presence={presence}
        rising={emerging}
        grabbed={!!drag}
        draggable={!speaking && presence !== 'gone'}
        label={speaking ? 'Layers' : 'Layers. Ask a question, or drag to move.'}
        onClick={props.onMascotClick}
        onDrag={(centre) => setDrag(clampToView(centre))}
        onDrop={onDrop}
      />
      {arrived && !emerging && anchor === 'composer' && (
        <Bubble
          key={isCompact(scene) ? 'chip' : 'bubble'}
          scene={scene}
          placement={place}
          counters={props.counters}
          prefs={props.prefs}
          hasDraft={props.hasDraft}
          actions={props.actions}
          bubbleRef={bubbleRef}
        />
      )}
    </div>
  );
}
