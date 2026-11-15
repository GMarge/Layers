import { useState } from 'react';
import { chatOf, topicLabel, type Line, type Tree } from './model';

/**
 * The map of the conversation. Each dot is a prompt. A dashed drop is a direction
 * Layers noticed by itself; a solid rise is a branch the employee asked for.
 */

const STEP = 34;
const ROW = 22;
const PAD = 16;

interface Props {
  tree: Tree;
  onOpen(nodeId: string): void;
  onBranch(nodeId: string): void;
  onMerge(lineId: string): void;
}

function rowsFor(lines: Line[]): Map<string, number> {
  const rows = new Map<string, number>();
  let top = 0;
  for (const line of lines) {
    if (!line.parent) rows.set(line.id, 0);
    else if (line.kind === 'explicit') rows.set(line.id, --top);
    else rows.set(line.id, (rows.get(line.parent) ?? 0) + 1);
  }
  const min = Math.min(...rows.values());
  for (const [id, row] of rows) rows.set(id, row - min);
  return rows;
}

export function Rail({ tree, onOpen, onBranch, onMerge }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const rows = rowsFor(tree.lines);
  const depth = Math.max(...rows.values()) + 1;
  const x = (i: number) => PAD + i * STEP;
  const y = (line: string) => PAD + (rows.get(line) ?? 0) * ROW;
  const index = new Map(tree.nodes.map((n, i) => [n.id, i]));
  const end = x(tree.nodes.length - 1) + STEP * 0.7;
  const activeChat = chatOf(tree, tree.active);

  const strokes: { d: string; kind: string }[] = [];
  for (const line of tree.lines) {
    const mine = tree.nodes.filter((n) => n.line === line.id);
    const first = mine[0];
    const live = line.id === tree.active;

    // Where this line splits off its parent.
    if (line.parent && line.forkNode && first) {
      const fx = x(index.get(line.forkNode)!);
      const fy = y(line.parent);
      const tx = x(index.get(first.id)!);
      const ty = y(line.id);
      strokes.push(
        ty > fy
          ? { d: `M${fx} ${fy}V${ty - 6}q0 6 6 6H${tx}`, kind: 'fork-implicit' }
          : { d: `M${fx} ${fy}v-${fy - ty - 8}q0-8 8-8H${tx}`, kind: 'fork-explicit' },
      );
    }

    // Between prompts: dashed where the conversation left this line and came back.
    mine.forEach((node, n) => {
      const next = mine[n + 1];
      if (!next) return;
      const a = index.get(node.id)!;
      const b = index.get(next.id)!;
      strokes.push({ d: `M${x(a)} ${y(line.id)}H${x(b)}`, kind: b - a > 1 ? 'left' : live ? 'live' : 'quiet' });
    });

    const last = mine[mine.length - 1];
    if (!last) continue;
    const lx = x(index.get(last.id)!);
    if (line.merged && line.parent) {
      strokes.push({ d: `M${lx} ${y(line.id)}h8q6 0 6-6V${y(line.parent)}`, kind: 'merge' });
    } else if (live) {
      strokes.push({ d: `M${lx} ${y(line.id)}H${end}`, kind: 'live' });
    } else if (lx < end - STEP) {
      strokes.push({ d: `M${lx} ${y(line.id)}H${end}`, kind: 'left' });
    }
  }

  const chosen = tree.nodes.find((n) => n.id === picked) ?? null;
  const chosenLine = chosen ? tree.lines.find((l) => l.id === chosen.line)! : null;

  return (
    <div className="rail" aria-label="Conversation map">
      <div className="rail__scroll">
        <div className="rail__map" style={{ width: end + PAD, height: PAD * 2 + (depth - 1) * ROW }}>
          <svg width={end + PAD} height={PAD * 2 + (depth - 1) * ROW} aria-hidden="true">
            {strokes.map((s, i) => (
              <path key={i} d={s.d} className={`rail__stroke rail__stroke--${s.kind}`} />
            ))}
          </svg>
          {tree.nodes.map((node, i) => (
            <button
              key={node.id}
              type="button"
              className="rail__dot"
              data-live={node.line === tree.active ? '' : undefined}
              data-away={chatOf(tree, node.line) !== activeChat ? '' : undefined}
              data-reopened={node.reopened ? '' : undefined}
              aria-pressed={picked === node.id}
              aria-label={`Prompt ${i + 1}: ${node.text.slice(0, 60)}`}
              style={{ left: x(i), top: y(node.line) }}
              onClick={() => setPicked(picked === node.id ? null : node.id)}
            />
          ))}
        </div>
      </div>
      {chosen && chosenLine && (
        <div className="rail__card">
          <p>
            <b>{chosenLine.kind === 'implicit' ? 'Layers noticed' : chosenLine.kind === 'explicit' ? 'Your branch' : 'Main line'}</b>
            {topicLabel(chosenLine.topic)}
          </p>
          <p className="rail__text">{chosen.text}</p>
          <div className="rail__acts">
            <button type="button" onClick={() => onOpen(chosen.id)}>
              Go to it
            </button>
            <button type="button" onClick={() => (onBranch(chosen.id), setPicked(null))}>
              Branch from here
            </button>
            {chosenLine.kind === 'implicit' && !chosenLine.merged && (
              <button type="button" onClick={() => (onMerge(chosenLine.id), setPicked(null))}>
                Merge back
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
