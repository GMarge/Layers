import { useState } from 'react';
import type { MapShape } from './model';

/**
 * The map of a conversation. Each dot is a prompt, and each row is one line of thought.
 * A dashed blue drop is a direction Layers noticed by itself. A solid rise is a chat of
 * its own. It draws from the shape alone, so the manager's copy never holds prompt text.
 */

interface Props {
  shape: MapShape;
  size?: 'full' | 'small';
  /** Index of the chosen prompt. Leave out `onPick` for a map that is only looked at. */
  picked?: number | null;
  onPick?(index: number | null): void;
  /** What a dot is called for a screen reader. */
  describe?(index: number): string;
  /** Index of the chosen stopped prompt, and what to do when one is picked. */
  pickedStop?: number | null;
  onPickStop?(index: number | null): void;
}

const SIZES = {
  full: { step: 40, row: 34, pad: 20, fold: 60 },
  small: { step: 26, row: 24, pad: 14, fold: 44 },
};

/** One row per line. Chats made later sit higher, each with its noticed directions under it. */
function rowsFor(shape: MapShape): string[] {
  const byId = new Map(shape.lines.map((l) => [l.id, l]));
  const chatOf = (id: string) => {
    let line = byId.get(id)!;
    while (line.kind === 'implicit' && line.parent) line = byId.get(line.parent)!;
    return line.id;
  };
  const order: string[] = [];
  for (const head of shape.lines.filter((l) => l.kind !== 'implicit').reverse()) {
    order.push(head.id);
    for (const line of shape.lines) if (line.kind === 'implicit' && chatOf(line.id) === head.id) order.push(line.id);
  }
  return order;
}

interface Fold {
  key: number;
  count: number;
  x1: number;
  x2: number;
  line: string;
}

/** Where each prompt sits. A long unbroken run is folded into a zigzag until it is opened. */
function place(shape: MapShape, opened: Set<number>, step: number, foldWidth: number) {
  const n = shape.nodes.length;
  const forks = new Set(shape.lines.map((l) => l.fork));
  const stops = shape.stops ?? [];
  // A stopped prompt sits just after the last prompt that was sent before it.
  const stoppedAfter = (i: number) => stops.map((s, k) => (Math.min(Math.max(s.after, 0), n - 1) === i ? k : -1)).filter((k) => k >= 0);
  const keep = shape.nodes.map((node, i) => {
    const before = shape.nodes[i - 1];
    const after = shape.nodes[i + 1];
    return (
      !before ||
      !after ||
      before.line !== node.line ||
      after.line !== node.line ||
      forks.has(i) ||
      node.reopened ||
      stoppedAfter(i).length > 0
    );
  });

  const xs: number[] = [];
  const stopXs: number[] = [];
  const hidden = new Set<number>();
  const folds: Fold[] = [];
  let x = 0;
  for (let i = 0; i < n; ) {
    if (keep[i]) {
      xs[i] = x;
      const here = stoppedAfter(i);
      here.forEach((k, j) => {
        stopXs[k] = x + step * 0.55 * (j + 1);
      });
      x += step + step * 0.55 * here.length;
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !keep[j]) j += 1;
    if (j - i >= 3 && !opened.has(i)) {
      const from = x - step;
      for (let k = i; k < j; k++) {
        hidden.add(k);
        xs[k] = from + foldWidth / 2;
      }
      folds.push({ key: i, count: j - i, x1: from, x2: from + foldWidth, line: shape.nodes[i]!.line });
      x = from + foldWidth;
    } else {
      for (let k = i; k < j; k++) {
        xs[k] = x;
        x += step;
      }
    }
    i = j;
  }
  return { xs, stopXs, hidden, folds, width: Math.max(0, x - step) };
}

export function BranchMap({ shape, size = 'full', picked = null, onPick, describe, pickedStop = null, onPickStop }: Props) {
  const [opened, setOpened] = useState<Set<number>>(() => new Set());
  const { step, row, pad, fold } = SIZES[size];
  const order = rowsFor(shape);
  const rowOf = new Map(order.map((id, i) => [id, i]));
  const { xs, stopXs, hidden, folds, width } = place(shape, opened, step, fold);
  const stub = size === 'full' ? 14 : 10;

  const x = (i: number) => pad + (xs[i] ?? 0);
  const y = (line: string) => pad + (rowOf.get(line) ?? 0) * row;
  const end = pad + width + step * 0.7;
  const height = pad * 2 + (order.length - 1) * row;
  const byId = new Map(shape.lines.map((l) => [l.id, l]));
  const chatOf = (id: string) => {
    let line = byId.get(id)!;
    while (line.kind === 'implicit' && line.parent) line = byId.get(line.parent)!;
    return line.id;
  };
  const activeChat = byId.has(shape.active) ? chatOf(shape.active) : '';

  const strokes: { d: string; kind: string }[] = [];
  for (const line of shape.lines) {
    const mine = shape.nodes.map((node, i) => (node.line === line.id && !hidden.has(i) ? i : -1)).filter((i) => i >= 0);
    const first = mine[0];
    const live = line.id === shape.active;
    const ly = y(line.id);

    // Where this line splits off its parent.
    if (line.parent && line.fork !== null && line.fork >= 0) {
      const fx = x(line.fork);
      // It leaves from the prompt it followed, on whichever row that prompt sits.
      const fy = y(shape.nodes[line.fork]?.line ?? line.parent);
      const tx = first === undefined ? fx + step * 0.7 : x(first);
      const kind = line.kind === 'implicit' ? 'fork-implicit' : line.promoted ? 'fork-promoted' : 'fork-explicit';
      strokes.push({
        d: ly > fy ? `M${fx} ${fy}V${ly - 7}q0 7 7 7H${tx}` : `M${fx} ${fy}V${ly + 7}q0 -7 7 -7H${tx}`,
        kind,
      });
    }

    // Between prompts: dashed where the conversation left this line and came back.
    mine.forEach((a, n) => {
      const b = mine[n + 1];
      if (b === undefined) return;
      const folded = folds.find((f) => f.key > a && f.key < b && f.line === line.id);
      if (folded) {
        const z = folded.x1 + pad + (fold - 32) / 2;
        strokes.push({
          d: `M${x(a)} ${ly}H${z}l4 -6l8 12l8 -12l8 12l4 -6H${x(b)}`,
          kind: live ? 'live' : 'quiet',
        });
        return;
      }
      strokes.push({ d: `M${x(a)} ${ly}H${x(b)}`, kind: b - a > 1 ? 'left' : live ? 'live' : 'quiet' });
    });

    const last = mine[mine.length - 1];
    if (last === undefined) continue;
    const lx = x(last);
    if (line.merged && line.parent) {
      strokes.push({ d: `M${lx} ${ly}h9q7 0 7 -7V${y(line.parent)}`, kind: 'merge' });
    } else if (live) {
      strokes.push({ d: `M${lx} ${ly}H${end}`, kind: 'live' });
    } else if (lx < end - step) {
      strokes.push({ d: `M${lx} ${ly}H${end}`, kind: 'left' });
    }
  }

  return (
    <div className="bmap" data-size={size}>
      <ul className="bmap__names" style={{ padding: `${pad - row / 2}px 0` }}>
        {order.map((id) => {
          const line = byId.get(id)!;
          return (
            <li key={id} style={{ height: row }} data-kind={line.kind} data-live={id === shape.active ? '' : undefined}>
              <span>{line.label}</span>
              {line.kind === 'explicit' && <em>{line.promoted ? 'chat, grouped' : 'chat'}</em>}
              {line.kind === 'implicit' && <em>{line.merged ? 'merged' : 'noticed'}</em>}
            </li>
          );
        })}
      </ul>
      <div className="bmap__scroll">
        <div className="bmap__map" style={{ width: end + pad, height }}>
          <svg width={end + pad} height={height} aria-hidden="true">
            {strokes.map((s, i) => (
              <path key={i} d={s.d} className={`bmap__stroke bmap__stroke--${s.kind}`} />
            ))}
            {(shape.stops ?? []).map((s, k) => {
              // A dead end: up off the line, and capped. The prompt went no further.
              const sx = pad + (stopXs[k] ?? 0);
              const sy = y(s.line);
              return (
                <path
                  key={`stop-${k}`}
                  d={`M${sx} ${sy}V${sy - stub}M${sx - 5} ${sy - stub}H${sx + 5}`}
                  className="bmap__stroke bmap__stroke--stop"
                  data-state={s.state}
                />
              );
            })}
          </svg>
          {onPickStop &&
            (shape.stops ?? []).map((s, k) => (
              <button
                key={`stop-${k}`}
                type="button"
                className="bmap__stop"
                style={{ left: pad + (stopXs[k] ?? 0), top: y(s.line) - stub }}
                aria-pressed={pickedStop === k}
                aria-label={`A prompt that was stopped${s.state === 'waiting' ? ' and is with your manager' : s.state === 'declined' ? ' and declined' : ''}`}
                title="A prompt that was stopped"
                onClick={() => onPickStop(pickedStop === k ? null : k)}
              />
            ))}
          {folds.map((f) => (
            <button
              key={f.key}
              type="button"
              className="bmap__fold"
              style={{ left: pad + f.x1 + fold / 2, top: y(f.line) }}
              title={`${f.count} more prompts in a row. Click to show them.`}
              aria-label={`Show ${f.count} more prompts`}
              onClick={() => setOpened((s) => new Set(s).add(f.key))}
            >
              {f.count}
            </button>
          ))}
          {shape.nodes.map((node, i) => {
            if (hidden.has(i)) return null;
            const common = {
              className: 'bmap__dot',
              'data-live': node.line === shape.active ? '' : undefined,
              'data-away': byId.has(node.line) && chatOf(node.line) !== activeChat ? '' : undefined,
              'data-reopened': node.reopened ? '' : undefined,
              style: { left: x(i), top: y(node.line) },
            };
            // A prompt that came back to a line shows which visit it was.
            const mark = node.reopened ? <span>{node.visit}</span> : null;
            return onPick ? (
              <button
                key={i}
                type="button"
                {...common}
                aria-pressed={picked === i}
                aria-label={describe?.(i) ?? `Prompt ${i + 1}`}
                onClick={() => onPick(picked === i ? null : i)}
              >
                {mark}
              </button>
            ) : (
              <span key={i} {...common}>
                {mark}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
