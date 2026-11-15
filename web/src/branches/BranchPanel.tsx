import { useEffect, useRef, useState } from 'react';
import { Plan, Steps } from '../layers/Bubble';
import type { AgentRun, Counters, Task, UpdateState } from '../layers/types';
import { Check, Close } from '../ui/icons';
import { BranchMap } from './Map';
import { TOPICS, chatOf, chatTitle, chatsOf, effort, openLines, shapeOf, type Tree } from './model';

/**
 * The page Layers opens when asked for the branches: the map of the conversation, the
 * chats it has split into, and what the employee has got done so far today.
 */

export type PanelTab = 'branches' | 'today' | 'agent';

interface Props {
  tab: PanelTab;
  tree: Tree;
  rootTitle: string;
  projectName: string;
  agentName: string;
  tasks: Task[];
  counters: Counters;
  /** What the agent did this session, newest first. */
  runs: AgentRun[];
  /** Whether the live agent is behind this workspace, in a sentence. */
  live: string;
  /** The status update for the manager, wherever it stands. */
  update: UpdateState;
  managerName: string;
  onDraftUpdate(): void;
  onSendUpdate(text: string, approved: boolean): void;
  onTab(tab: PanelTab): void;
  onClose(): void;
  onOpenNode(nodeId: string): void;
  onOpenChat(lineId: string): void;
  onBranch(nodeId: string): void;
  onMerge(lineId: string): void;
  onMergeAll(): void;
  onDetach(lineId: string): void;
  onFold(lineId: string): void;
  /** Put a stopped prompt back in the chat box, or clear its mark from the map. */
  onRestoreStop(text: string): void;
  onDropStop(text: string): void;
}

const STOPPED = {
  held: 'It was not sent, and it is still not sent.',
  waiting: 'It is with your manager. It will be sent only if they approve it.',
  declined: 'Your manager declined it, so it was not sent.',
};

function Branches(p: Props) {
  const { tree } = p;
  const [picked, setPicked] = useState<number | null>(null);
  const [pickedStop, setPickedStop] = useState<number | null>(null);
  const stop = pickedStop === null ? null : ((tree.stops ?? [])[pickedStop] ?? null);
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
        onPick={(i) => (setPicked(i), setPickedStop(null))}
        describe={(i) => `Prompt ${i + 1}: ${tree.nodes[i]?.text.slice(0, 60) ?? ''}`}
        pickedStop={pickedStop}
        onPickStop={(k) => (setPickedStop(k), setPicked(null))}
      />

      <ul className="bpanel__legend" aria-label="How to read the map">
        <li data-key="dot">A prompt</li>
        <li data-key="back">Came back to a line, and which visit it was</li>
        <li data-key="noticed">Noticed by {p.agentName}</li>
        <li data-key="chat">Its own chat</li>
        <li data-key="stop">Stopped, and not sent</li>
        <li data-key="fold">A long run, folded. Click the number to open it</li>
      </ul>

      {stop ? (
        <div className="bpanel__card">
          <p className="bpanel__kind">
            <b>{stop.why === 'policy' ? 'Stopped under rule AI-01' : `${p.agentName} could not tell, and stopped it`}</b>
            in {chatTitle(tree, chatOf(tree, stop.line), p.rootTitle)}
          </p>
          <p className="bpanel__text">{stop.text}</p>
          <p className="bpanel__hint">{STOPPED[stop.state]}</p>
          <div className="bpanel__acts">
            {stop.state !== 'waiting' && (
              <button type="button" className="bpanel__btn" onClick={() => p.onRestoreStop(stop.text)}>
                Put it back in the chat box
              </button>
            )}
            <button type="button" className="bpanel__btn" onClick={() => (p.onDropStop(stop.text), setPickedStop(null))}>
              Clear it from the map
            </button>
          </div>
        </div>
      ) : node && line ? (
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
        <p className="bpanel__hint">Pick a dot, or a red stop, to read the prompt and see what you can do with it.</p>
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

/** The agent's second job: write the manager an update from the day's results, and wait. */
function UpdateCard(p: Props) {
  const u = p.update;
  const [text, setText] = useState(u.text);
  useEffect(() => setText(u.text), [u.text]);
  const busy = u.phase === 'sending';
  const mine = text.trim() !== u.text;

  return (
    <div className="bpanel__update">
      <div className="bpanel__intro">
        <p>
          <b>Tell {p.managerName} where things stand.</b> {p.agentName} writes a short update from your tasks and the
          counts on this page. It never quotes what you typed, and nothing is sent until you approve it.
        </p>
        {(u.phase === 'idle' || u.phase === 'sent') && (
          <button type="button" className="bpanel__btn bpanel__btn--go" onClick={p.onDraftUpdate}>
            {u.phase === 'sent' ? 'Draft another' : 'Draft an update'}
          </button>
        )}
      </div>

      {u.phase !== 'idle' && u.phase !== 'sent' && (
        <>
          <Plan todos={u.plan} />
          <Steps steps={u.steps} />
        </>
      )}

      {(u.phase === 'draft' || u.phase === 'sending') && (
        <>
          <textarea
            className="bpanel__draft"
            value={text}
            rows={4}
            disabled={busy}
            aria-label="The update, as it will be sent"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="bpanel__acts">
            <button type="button" className="act act--primary" disabled={busy || !text.trim()} onClick={() => p.onSendUpdate(text, true)}>
              <span>{mine ? `Send my wording to ${p.managerName}` : `Send to ${p.managerName}`}</span>
            </button>
            <button type="button" className="act" disabled={busy} onClick={() => p.onSendUpdate(u.text, false)}>
              <span>Don't send</span>
            </button>
          </div>
          <p className="bpanel__hint">
            {u.by === 'agent'
              ? 'The agent is paused on this and cannot send it without you. Change the wording if you like: yours is what goes.'
              : u.by === 'code'
                ? 'Plain code wrote this, because no model is connected. It still waits for you.'
                : 'The scripted preview wrote this. Nothing is really sent from the preview.'}
          </p>
        </>
      )}

      {u.phase === 'sent' && (
        <p className="bpanel__sent">
          <b>
            Sent to {p.managerName}
            {u.at ? ` at ${new Date(u.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.
          </b>{' '}
          {u.text}
        </p>
      )}
    </div>
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

      <UpdateCard {...p} />

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

/** Every tool the agent has. This list mirrors server/tools.py and server/agent.py. */
const TOOLS: [name: string, does: string, waits?: boolean][] = [
  ['get_project_context', 'Read your project brief and task list'],
  ['check_company_policy', 'Check a prompt against the workspace rules'],
  ['search_org_memory', "Search the team's approved workflows it is allowed to see"],
  ['submit_verdict', 'Give its finding on a prompt, and the direction it belongs to'],
  ['write_todos', 'Write its own plan before it acts'],
  ['check_access', 'Confirm you may use a workflow'],
  ['create_project_artifact', 'Build a document in your project', true],
  ['update_task_status', 'Move a project task along'],
  ['request_manager_approval', 'Ask your manager to decide'],
  ['get_todays_activity', 'Read what got done today: tasks, documents and counts, never what you typed'],
  ['send_status_update', 'Send your manager an update you have read', true],
];

const DID: Record<AgentRun['kind'], string> = {
  review: 'Checked a prompt',
  apply: 'Applied a team workflow',
  update: 'Drafted an update',
};

const BY: Record<AgentRun['by'], string> = {
  agent: 'DeepAgent',
  code: 'Plain code, no model',
  preview: 'Scripted preview',
};

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function Agent(p: Props) {
  return (
    <>
      <div className="bpanel__intro">
        <p>{p.live} The list at the bottom is what actually ran in this session. Nothing in it is staged.</p>
      </div>

      <ol className="bpanel__how">
        <li>
          <b>The gate decides.</b> Plain code checks every prompt against your project and the rules when you press
          Send. It is the only thing that can let a prompt through, and no model can overrule it.
        </li>
        <li>
          <b>The agent looks when the gate cannot tell.</b> It is a LangChain DeepAgent. It reads the brief, checks the
          rules, searches your team's work, writes its own plan, and says what it found and why.
        </li>
        <li>
          <b>A person approves.</b> Before the agent creates anything, the harness stops it and waits for you. Only
          your manager can approve a held prompt.
        </li>
      </ol>

      <h3>What the agent can do</h3>
      <ul className="bpanel__tools">
        {TOOLS.map(([name, does, waits]) => (
          <li key={name}>
            <code>{name}</code>
            <span>{does}</span>
            {waits && <em>waits for you</em>}
          </li>
        ))}
      </ul>

      <h3>What it did</h3>
      {p.runs.length === 0 ? (
        <p className="bpanel__hint">Nothing yet. Send a prompt and it shows up here.</p>
      ) : (
        <ul className="bpanel__runs">
          {p.runs.map((run) => (
            <li key={run.id}>
              <details>
                <summary>
                  <time>{clock(run.at)}</time>
                  <b>{DID[run.kind]}</b>
                  <span className="bpanel__by" data-by={run.by}>
                    {BY[run.by]}
                  </span>
                  <span className="bpanel__n">
                    {run.steps.length} {run.steps.length === 1 ? 'tool call' : 'tool calls'}, {(run.ms / 1000).toFixed(1)} s
                  </span>
                </summary>
                <p className="bpanel__text">{run.prompt}</p>
                <p className="bpanel__hint">{run.outcome}</p>
                {run.steps.length === 0 ? (
                  <p className="bpanel__hint">
                    {run.by === 'preview'
                      ? 'The preview is scripted, so there are no tool calls to show.'
                      : 'The gate settled this in code, so the agent was not needed.'}
                  </p>
                ) : (
                  <>
                    <Plan todos={run.plan} />
                    <Steps steps={run.steps} />
                  </>
                )}
              </details>
            </li>
          ))}
        </ul>
      )}
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
      <section className="bpanel" ref={ref} role="dialog" aria-modal="true" aria-label="Branches, progress and the agent" tabIndex={-1}>
        <header className="bpanel__head">
          <div className="bpanel__tabs" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={p.tab === 'branches'} onClick={() => p.onTab('branches')}>
              Branches
            </button>
            <button type="button" role="tab" aria-selected={p.tab === 'today'} onClick={() => p.onTab('today')}>
              Today so far
            </button>
            <button type="button" role="tab" aria-selected={p.tab === 'agent'} onClick={() => p.onTab('agent')}>
              Agent
            </button>
          </div>
          <button type="button" className="bpanel__close" aria-label="Close" onClick={p.onClose}>
            <Close />
          </button>
        </header>
        <div className="bpanel__body">
          {p.tab === 'branches' ? <Branches {...p} /> : p.tab === 'today' ? <Today {...p} /> : <Agent {...p} />}
        </div>
      </section>
    </div>
  );
}
