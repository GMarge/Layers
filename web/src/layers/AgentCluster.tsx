import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMediaQuery } from '../ui/useMediaQuery';
import { AgentMenu } from './AgentMenu';
import { Bubble, isCompact, type BubbleActions, type BubblePlacement, type Prefs } from './Bubble';
import { Mascot, type Mood, type Presence, type Shape } from './Mascot';
import type { Counters, Placement, RestMode, Scene } from './types';
import { useSpringPosition, type Point } from './useSpringPosition';

const HALF = 32; // half the mascot's size
const DOCK = 58; // distance from the corner to the mascot's centre when floating with no chosen spot
const GAP = 14; // space between the mascot and the composer it speaks from
const HOME_KEY = 'layers.home';
const EMERGE_MS = 900;
const QUICK = 0.5; // a drag-off plays the pop-out at this fraction of its normal length
const EMERGE_QUICK_MS = EMERGE_MS * QUICK; // how long the droplet takes to form before the agent lifts off

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
  branch: 'found',
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
  // Far enough in that the swell clears the box's rounded corner.
  return { x: Math.round(r.left + 68), y: Math.round(r.top - HALF - GAP) };
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
  /** Reports when the agent is being held over the chat box. */
  onOverBoxChange: (over: boolean) => void;
}

export function AgentCluster(props: Props) {
  const { scene, placement, rest, reducedMotion } = props;
  const clusterRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery('(max-width: 640px)');

  const [drag, setDrag] = useState<Point | null>(null);
  /** Where the right-click menu is open, if it is. */
  const [menu, setMenu] = useState<Point | null>(null);
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

  // Leaving the chat box always plays the same pop-out, whether he was tapped or dragged.
  // He forms at the box first, and only then goes where he is headed. Hiding is not
  // leaving: that is a fade in place.
  const inBox = anchor === 'absorbed';
  const wasInBox = useRef(inBox);
  const [emerging, setEmerging] = useState(false);
  /** A drag-off plays the pop-out faster, so he reaches the pointer sooner. */
  const [quick, setQuick] = useState(false);
  const emergeTimer = useRef(0);
  /** Where he finished forming, when he then has to catch up with the pointer. */
  const flight = useRef<{ from: Point; at: number } | null>(null);
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  useLayoutEffect(() => {
    const leaving = wasInBox.current && !inBox;
    wasInBox.current = inBox;
    if (inBox) {
      // Back in the box before he finished forming: stop.
      clearTimeout(emergeTimer.current);
      setEmerging(false);
      return;
    }
    if (!leaving || reducedMotion || anchor === 'hidden') return;
    const fast = anchor === 'drag';
    setQuick(fast);
    setEmerging(true);
    clearTimeout(emergeTimer.current);
    emergeTimer.current = window.setTimeout(
      () => {
        if (anchorRef.current === 'drag') flight.current = { from: absorbedPoint(), at: performance.now() };
        setEmerging(false);
      },
      fast ? EMERGE_QUICK_MS : EMERGE_MS,
    );
    // Keyed on leaving the box only. Where he goes afterwards must not restart or cut it short.
  }, [inBox]);
  useEffect(() => () => clearTimeout(emergeTimer.current), []);

  // Start at the intended anchor, rather than flashing at the bottom-right dock.
  const [target, setTarget] = useState<Point>(() => {
    if (anchor === 'composer' || anchor === 'absorbed') return composerPoint();
    return home ? clampToView(home) : dockPoint();
  });
  // A drag follows the pointer exactly, except while he is still forming at the box.
  const arrived = useSpringPosition(clusterRef, target, reducedMotion || (anchor === 'drag' && !emerging));

  // He formed at the box while the pointer moved on. Now that he follows the pointer,
  // fly him over from where he formed, so he catches up in one move instead of jumping.
  useLayoutEffect(() => {
    const f = flight.current;
    if (!f || emerging) return;
    if (anchor !== 'drag' || performance.now() - f.at > 160) {
      flight.current = null;
      return;
    }
    const dx = f.from.x - target.x;
    const dy = f.from.y - target.y;
    if (Math.hypot(dx, dy) < 4) return; // the target has not moved to the pointer yet
    flight.current = null;
    clusterRef.current
      ?.querySelector<HTMLElement>('.mascot')
      ?.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
        duration: 300,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
  }, [target.x, target.y, emerging, anchor]);

  // The spring's 'arrived' signal is intentionally generous. Do not pop the
  // speech bubble before the mascot visually reaches the final few pixels.
  const [bubbleReady, setBubbleReady] = useState(false);
  useEffect(() => {
    if (anchor !== 'composer' || emerging || !arrived) {
      setBubbleReady(false);
      return;
    }

    let frame = 0;
    const check = () => {
      const r = clusterRef.current?.getBoundingClientRect();
      if (!r) return;
      if (Math.hypot(r.left - target.x, r.top - target.y) <= 3) {
        setBubbleReady(true);
      } else {
        frame = requestAnimationFrame(check);
      }
    };
    setBubbleReady(false);
    check();
    return () => cancelAnimationFrame(frame);
  }, [anchor, emerging, arrived]);

  const onReserve = useRef(props.onReserveChange);
  onReserve.current = props.onReserveChange;

  // Keep the target glued to the chat box as the layout around it changes,
  // and tell the chat how much room to leave so nothing is covered.
  useLayoutEffect(() => {
    const compute = () => {
      const bubbleHeight = bubbleRef.current?.offsetHeight ?? 0;
      if (anchor === 'hidden') {
        // Hidden: stay exactly where he was. He fades out in place and comes back in place.
        onReserve.current(0);
        return;
      }
      let next: Point;
      // While he forms he stays at the box, wherever he is headed next.
      if (emerging) next = absorbedPoint();
      else if (anchor === 'drag' && drag) next = drag;
      else if (anchor === 'composer') next = composerPoint();
      else if (anchor === 'absorbed') next = absorbedPoint();
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
    anchor === 'hidden' ? 'gone' : arrived && anchor === 'absorbed' ? 'in' : 'out';
  // The chat box keeps its outline until the droplet has left it.
  const absorbed = presence === 'in' || emerging;
  const onAbsorbed = useRef(props.onAbsorbedChange);
  onAbsorbed.current = props.onAbsorbedChange;
  useEffect(() => onAbsorbed.current(absorbed), [absorbed]);

  const overBox = (centre: Point) => {
    const r = composerRect();
    return !!r && centre.x > r.left - 24 && centre.x < r.right + 24 && centre.y > r.top - 44 && centre.y < r.bottom + 24;
  };
  const over = !!drag && overBox(drag);
  const onOver = useRef(props.onOverBoxChange);
  onOver.current = props.onOverBoxChange;
  useEffect(() => onOver.current(over), [over]);

  // Right-click opens a one-line menu: hide him when he is showing, show him when he is hidden.
  const hiddenNow = presence === 'gone';
  const busy = scene.name === 'working' || scene.name === 'checking';
  useEffect(() => {
    if (!hiddenNow) return;
    // Nothing of him is on screen to click, so listen for a right-click where he was.
    // Anywhere else, the browser's own menu still opens as usual.
    const onContext = (e: MouseEvent) => {
      const r = clusterRef.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      if (Math.abs(dx) > 44 || dy < -44 || dy > 60) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener('contextmenu', onContext, true);
    return () => window.removeEventListener('contextmenu', onContext, true);
  }, [hiddenNow]);

  const chooseMenu = () => {
    setMenu(null);
    if (hiddenNow) {
      props.actions.toggleHidden();
      return;
    }
    // Hiding puts away whatever he was saying. A held prompt keeps its Review link.
    if (speaking) props.actions.dismiss();
    if (rest !== 'hidden') props.actions.toggleHidden();
  };

  /** Dropping the agent on the chat box tucks it in. Anywhere else becomes its new spot. */
  const onDrop = (centre: Point) => {
    setDrag(null);
    const onComposer = overBox(centre);
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
    <>
      {menu && (
        <AgentMenu
          at={menu}
          label={hiddenNow ? 'Show Layers' : 'Hide Layers'}
          onChoose={chooseMenu}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="cluster" ref={clusterRef} data-place={place}>
      <Mascot
        shape={props.shape}
        mood={mood}
        nod={props.nod}
        followPointer={!speaking && !drag}
        presence={presence}
        rising={emerging}
        quick={quick}
        reducedMotion={reducedMotion}
        grabbed={!!drag}
        over={over}
        draggable={!emerging && presence !== 'gone' && scene.name !== 'working' && scene.name !== 'checking'}
        label={speaking ? 'Layers. Drag to move.' : 'Layers. Ask a question, or drag to move.'}
        onClick={props.onMascotClick}
        onMenu={(at) => {
          if (!busy) setMenu(at);
        }}
        onDrag={(centre) => {
          // Picking him up while he is talking puts the bubble away. A tap brings it back.
          if (!drag && speaking) props.actions.dismiss();
          setDrag(clampToView(centre));
        }}
        onDrop={onDrop}
      />
      {arrived && bubbleReady && !emerging && anchor === 'composer' && (
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
    </>
  );
}
