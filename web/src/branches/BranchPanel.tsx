import { useEffect, useRef, useState } from 'react';
import type { Counters, Task } from '../layers/types';
import { Check, Close } from '../ui/icons';
import { BranchMap } from './Map';
import { TOPICS, chatOf, chatTitle, chatsOf, effort, openLines, shapeOf, type Tree } from './model';

/**
 * The page Layers opens when asked for the branches: the map of the conversation, the
 * chats it has split into, and what the employee has got done so far today.
 */

export type PanelTab = 'branches' | 'today';

interface Props {
  tab: PanelTab;
  tree: Tree;
  rootTitle: string;
  projectName: string;
  agentName: string;
  tasks: Task[];
  counters: Counters;
  onTab(tab: PanelTab): void;
  onClose(): void;
  onOpenNode(nodeId: string): void;
  onOpenChat(lineId: string): void;
  onBranch(nodeId: string): void;
  onMerge(lineId: string): void;
  onMergeAll(): void;
  onDetach(lineId: string): void;
  onFold(lineId: string): void;
}

function Branches(p: Props) {
  const { tree } = p;
  const [picked, setPicked] = useState<number | null>(null);
  const node = picked === null ? null : (tree.nodes[picked] ?? null);
  const line = node ? tree.lines.find((l) => l.id === node.line)! : null;
  const here = chatOf(tree, tree.active);
  const open = openLines(tree, here);
  const chats = chatsOf(tree);
  const parentTitle = line?.parent ? chatTitle(tree, chatOf(tree, line.parent), p.rootTitle) : '';

  return (
    <>
      <div className="bpanel__intro">
        <p>
          How this conversation has split. Each dot is a prompt. {p.agentName} gives a new direction its own line, and
          moves one you keep coming back to into its own chat.
        </p>
        {open.length > 0 && (
          <button type="button" className="bpanel__btn" onClick={p.onMergeAll}>
            Merge all back ({open.length})
          </button>
        )}
      </div>

      <BranchMap
        shape={shapeOf(tree, p.rootTitle)}
        picked={picked}
        onPick={setPicked}
        describe={(i) => `Prompt ${i + 1}: ${tree.nodes[i]?.text.slice(0, 60) ?? ''}`}
      />

      <ul className="bpanel__legend" aria-label="How to read the map">
        <li data-key="dot">A prompt</li>
        <li data-key="back">Came back to a line, and which visit it was</li>
        <li data-key="noticed">Noticed by {p.agentName}</li>
        <li data-key="chat">Its own chat</li>
        <li data-key="fold">A long run, folded. Click the number to open it</li>
      </ul>

      {node && line ? (
        <div className="bpanel__card">
          <p className="bpanel__kind">
            <b>
              {line.kind === 'implicit'
                ? `Noticed by ${p.agentName}`
                : line.kind === 'explicit'
                  ? line.promoted
                    ? `Chat grouped by ${p.agentName}`
                    : 'Your branch'
                  : 'Where it started'}
            </b>
            {chatTitle(tree, line.id, p.rootTitle)}
            {node.reopened && `, visit ${node.visit}`}
          </p>
          <p className="bpanel__text">{node.text}</p>
          <div className="bpanel__acts">
            <button type="button" className="bpanel__btn" onClick={() => p.onOpenNode(node.id)}>
              Go to it
            </button>
            <button type="button" className="bpanel__btn" onClick={() => p.onBranch(node.id)}>
              New chat from here
            </button>
            {line.kind === 'implicit' && !line.merged && (
              <>
                <button type="button" className="bpanel__btn" onClick={() => (p.onMerge(line.id), setPicked(null))}>
                  Merge back
                </button>
                <button type="button" className="bpanel__btn" onClick={() => (p.onDetach(line.id), setPicked(null))}>
                  Make it its own chat
                </button>
              </>
            )}
            {line.kind === 'explicit' && line.cut !== undefined && (
              <button type="button" className="bpanel__btn" onClick={() => (p.onFold(line.id), setPicked(null))}>
                Put it back in {parentTitle}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="bpanel__hint">Pick a dot to read the prompt and see what you can do with it.</p>
      )}

      <h3>Chats</h3>
      <ul className="bpanel__chats">
        {chats.map((c) => {
          const head = tree.lines.find((l) => l.id === c.id)!;
          return (
            <li key={c.id} style={{ paddingLeft: c.depth * 18 }} data-here={c.id === here ? '' : undefined}>
              <span className="bpanel__chat">
                <b>{chatTitle(tree, c.id, p.rootTitle)}</b>
                <span>
                  {c.prompts} {c.prompts === 1 ? 'prompt' : 'prompts'}
                  {head.kind === 'main'
                    ? ', where it started'
                    : c.byLayers
                      ? `, grouped by ${p.agentName}`
                      : ', your branch'}
                </span>
              </span>
              {c.id === here ? (
                <em>You are here</em>
              ) : (
                <button type="button" className="bpanel__btn" onClick={() => p.onOpenChat(c.id)}>
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Today(p: Props) {
  const { tree } = p;
  const rows = effort(tree);
  const most = Math.max(1, ...rows.map((r) => r.prompts));
  const chats = chatsOf(tree).length;
  const promptsFor = (taskId: string) => {
    const topic = TOPICS.find((t) => t.task === taskId)?.id;
    return topic ? tree.nodes.filter((n) => tree.lines.find((l) => l.id === n.line)?.topic === topic).length : 0;
  };
  const done = p.tasks.filter((t) => t.status === 'done').length;

  return (
    <>
      <div className="bpanel__intro">
        <p>
          What you have got done on {p.projectName}, read from the branches of this conversation and your task list.
        </p>
      </div>

      <dl className="bpanel__stats">
        <div>
          <dt>Prompts sent</dt>
          <dd>{tree.nodes.length}</dd>
        </div>
        <div>
          <dt>Tasks done</dt>
          <dd>
            {done} of {p.tasks.length}
          </dd>
        </div>
        <div>
          <dt>Chats</dt>
          <dd>{chats}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{p.counters.held}</dd>
        </div>
        <div>
          <dt>Team work reused</dt>
          <dd>{p.counters.reused}</dd>
        </div>
      </dl>

      <h3>Tasks</h3>
      <ul className="bpanel__tasks">
        {p.tasks.map((t) => {
          const n = promptsFor(t.id);
          return (
            <li key={t.id} data-status={t.status}>
              <span className="proj__mark" aria-hidden="true">
                {t.status === 'done' && <Check />}
              </span>
              <span>{t.title}</span>
              <em>{t.status === 'done' ? 'Done' : t.status === 'doing' ? 'In progress' : 'Not started'}</em>
              <span className="bpanel__n">
                {n} {n === 1 ? 'prompt' : 'prompts'}
              </span>
            </li>
          );
        })}
      </ul>

      <h3>Where your prompts went</h3>
      <ul className="bpanel__bars">
        {rows.map((r) => (
          <li key={r.label}>
            <span>{r.label}</span>
            <span className="bpanel__bar" aria-hidden="true">
              <i style={{ width: `${(r.prompts / most) * 100}%` }} />
            </span>
            <b>{r.prompts}</b>
          </li>
        ))}
      </ul>

      <p className="bpanel__hint">
        These are counts from this session. Nothing here measures time, and it resets with the demo.
      </p>
    </>
  );
}

export function BranchPanel(p: Props) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(p.onClose);
  close.current = p.onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape closes only this page, not whatever the agent was saying behind it.
      e.stopImmediatePropagation();
      close.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div
      className="bpanel__veil"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <section className="bpanel" ref={ref} role="dialog" aria-modal="true" aria-label="Branches and progress" tabIndex={-1}>
        <header className="bpanel__head">
          <div className="bpanel__tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={p.tab === 'branches'} onClick={() => p.onTab('branches')}>
              Branches
            </button>
            <button type="button" role="tab" aria-selected={p.tab === 'today'} onClick={() => p.onTab('today')}>
              Today so far
            </button>
          </div>
          <button type="button" className="bpanel__close" aria-label="Close" onClick={p.onClose}>
            <Close />
          </button>
        </header>
        <div className="bpanel__body">{p.tab === 'branches' ? <Branches {...p} /> : <Today {...p} />}</div>
      </section>
    </div>
  );
}
