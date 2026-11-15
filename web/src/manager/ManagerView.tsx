import { useEffect, useRef, useState } from 'react';
import { BranchMap } from '../branches/Map';
import type { MapShape } from '../branches/model';
import { EdgeGlow } from '../layers/EdgeGlow';
import { MascotGlyph } from '../layers/Mascot';
import type { Signals, Task } from '../layers/types';
import { Check } from '../ui/icons';

/**
 * The manager's side of Layers: the whole team at a glance, then one person at a time.
 * It shows a prompt only when the employee sent it for approval. Everything else is
 * counts, outcomes and the shape of the conversation, never what was typed.
 */

interface Pending {
  id: string;
  prompt: string;
  note: string;
  reason: string;
  signals: Signals;
  from: string;
}

interface Member {
  id: string;
  name: string;
  role: string;
  team: string;
  /** A sample teammate, shown so the page reads as a team. Only the live one is connected. */
  sample: boolean;
  project: { name: string; title: string; due: string };
  tasks: Task[];
  counts: { checked: number; passed: number; held: number; reused: number };
  pending: number;
  feed: { ts?: number; text: string }[];
  branches: MapShape | null;
  /** Status updates this person chose to send, newest first. */
  updates?: { ts: number; text: string }[];
}

interface Settings {
  policy_mode: 'approval' | 'warn';
  unsure_mode: 'ask' | 'allow' | 'defer';
}

interface ManagerData {
  manager: string;
  project: { name: string; title: string; due: string };
  pending: Pending[];
  team: Member[];
  settings: Settings;
  rules: { id: string; name: string; text: string }[];
  /** How people on the team did their work: steps taken and the workflow used. */
  processes: { who: string; project: string; did: string; path: string[]; workflow: string; when: string; sample: boolean }[];
  /** The audit log in plain words. What the employee typed is not in it. */
  audit: { ts: number; who: string; what: string; note: string }[];
}

const POLICY: [Settings['policy_mode'], string][] = [
  ['approval', 'Hold it for my approval'],
  ['warn', 'Warn, and let them decide'],
];

const UNSURE: [Settings['unsure_mode'], string][] = [
  ['ask', 'Ask the employee'],
  ['allow', 'Send it and log it'],
  ['defer', 'Send it to me'],
];

type Pick = { kind: 'node'; i: number } | { kind: 'line'; id: string } | { kind: 'stop'; k: number } | { kind: 'task'; id: string } | null;

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** What one line of the conversation is, in a sentence the manager can act on. */
function lineKind(line: MapShape['lines'][number], first: string): string {
  if (line.kind === 'main') return 'Where the conversation started.';
  if (line.kind === 'implicit') return `A direction Layers noticed${line.merged ? `, since merged back in` : ''}.`;
  return line.promoted ? `Its own chat. Layers moved it there after ${first} kept coming back to it.` : `Its own chat, branched by ${first}.`;
}

/** The card under the manager's branch map: whatever was clicked, explained, with no prompt text. */
function Detail(props: { pick: Pick; shape: MapShape; tasks: Task[]; first: string; onPick(pick: Pick): void }) {
  const { pick, shape, tasks, first, onPick } = props;
  if (!pick) {
    return <p className="mgr__empty">Click a dot, a line's name, a red stop, or a task above to see more.</p>;
  }
  const lineOf = (id: string) => shape.lines.find((l) => l.id === id);
  const count = (id: string) => shape.nodes.filter((n) => n.line === id).length;
  const times = (id: string) => shape.nodes.filter((n) => n.line === id && n.at).map((n) => n.at as number);
  const taskOf = (id: string | null | undefined) => tasks.find((t) => t.id === id);

  if (pick.kind === 'node') {
    const node = shape.nodes[pick.i];
    const line = node && lineOf(node.line);
    if (!node || !line) return null;
    return (
      <div className="mgr__detail">
        <p>
          <b>
            Prompt {pick.i + 1} of {shape.nodes.length}
          </b>
          {node.at ? `, sent at ${clock(node.at)}` : ''}. On <b>{line.label}</b>
          {node.reopened ? `, the ${ordinal(node.visit)} time ${first} came back to it` : ''}.
        </p>
        <p className="mgr__empty">What it said is not shown. It went through, so it was on the project or approved.</p>
        <button type="button" className="mgr__more" onClick={() => onPick({ kind: 'line', id: line.id })}>
          See this line
        </button>
      </div>
    );
  }

  if (pick.kind === 'stop') {
    const stop = shape.stops?.[pick.k];
    const line = stop && lineOf(stop.line);
    if (!stop || !line) return null;
    return (
      <div className="mgr__detail">
        <p>
          <b>A prompt was stopped here</b>
          {stop.at ? ` at ${clock(stop.at)}` : ''}, while {first} was on <b>{line.label}</b>.{' '}
          {stop.why === 'unsure' ? 'Layers could not tell if it was project work.' : 'It was off project, under rule AI-01.'}
        </p>
        <p className="mgr__empty">
          {stop.state === 'waiting'
            ? 'It is waiting on you, in Needs you at the top of this page.'
            : stop.state === 'declined'
              ? 'You declined it, so it was never sent.'
              : `${first} left it there. It was never sent, and you were not asked.`}
        </p>
      </div>
    );
  }

  if (pick.kind === 'task') {
    const task = taskOf(pick.id);
    const lines = shape.lines.filter((l) => l.task === pick.id);
    const prompts = lines.reduce((sum, l) => sum + count(l.id), 0);
    if (!task) return null;
    return (
      <div className="mgr__detail">
        <p>
          <b>{task.title}</b>: {task.status === 'done' ? 'done' : task.status === 'doing' ? 'in progress' : 'not started'}.{' '}
          {lines.length === 0
            ? `Nothing in ${first}'s conversation has been about it yet.`
            : `${plural(prompts, 'prompt', 'prompts')} went to it, on ${plural(lines.length, 'line', 'lines')}, lit up on the map.`}
        </p>
        <div className="mgr__chips">
          {lines.map((l) => (
            <button key={l.id} type="button" className="mgr__more" onClick={() => onPick({ kind: 'line', id: l.id })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const line = lineOf(pick.id);
  if (!line) return null;
  const n = count(line.id);
  const share = Math.round((n / Math.max(1, shape.nodes.length)) * 100);
  const visits = Math.max(1, ...shape.nodes.filter((x) => x.line === line.id).map((x) => x.visit));
  const when = times(line.id);
  const parent = line.parent ? lineOf(line.parent) : undefined;
  const task = taskOf(line.task);
  const stopped = (shape.stops ?? []).filter((s) => s.line === line.id).length;
  return (
    <div className="mgr__detail">
      <p>
        <b>{line.label}.</b> {lineKind(line, first)}
      </p>
      <dl className="mgr__facts">
        <div>
          <dt>Prompts</dt>
          <dd>
            {n} <span>({share}% of the conversation)</span>
          </dd>
        </div>
        <div>
          <dt>Visits</dt>
          <dd>{visits}</dd>
        </div>
        {when.length > 0 && (
          <div>
            <dt>Active</dt>
            <dd>
              {clock(Math.min(...when))}
              {when.length > 1 ? ` to ${clock(Math.max(...when))}` : ''}
            </dd>
          </div>
        )}
        {parent && (
          <div>
            <dt>Split from</dt>
            <dd>
              {parent.label}
              {line.fork !== null && line.fork >= 0 ? `, after prompt ${line.fork + 1}` : ''}
            </dd>
          </div>
        )}
        {stopped > 0 && (
          <div>
            <dt>Stopped here</dt>
            <dd>{plural(stopped, 'prompt', 'prompts')}</dd>
          </div>
        )}
      </dl>
      {task && (
        <button type="button" className="mgr__more" onClick={() => onPick({ kind: 'task', id: task.id })}>
          Works towards: {task.title}
        </button>
      )}
    </div>
  );
}

function Choice<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange(value: T): void }) {
  return (
    <div className="mgr__seg" role="group" aria-label={props.label}>
      {props.options.map(([value, text]) => (
        <button key={value} type="button" aria-pressed={value === props.value} onClick={() => props.onChange(value)}>
          {text}
        </button>
      ))}
    </div>
  );
}

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const stamp = (ts: number) =>
  new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The branch map in words, for the line under it. */
function describe(shape: MapShape): string {
  const noticed = shape.lines.filter((l) => l.kind === 'implicit');
  const chats = shape.lines.filter((l) => l.kind === 'explicit');
  const grouped = chats.filter((l) => l.promoted).length;
  const parts = [plural(shape.nodes.length, 'prompt', 'prompts')];
  if (noticed.length > 0) {
    const merged = noticed.filter((l) => l.merged).length;
    parts.push(`${plural(noticed.length, 'direction', 'directions')} noticed${merged ? `, ${merged} merged back` : ''}`);
  }
  if (chats.length > 0) {
    parts.push(`${plural(chats.length, 'branch chat', 'branch chats')}${grouped ? `, ${grouped} grouped by Layers` : ''}`);
  }
  const stopped = shape.stops?.length ?? 0;
  if (stopped > 0) parts.push(`${plural(stopped, 'prompt', 'prompts')} stopped along the way`);
  return `${parts.join('. ')}.`;
}

export function ManagerView() {
  const [data, setData] = useState<ManagerData | null>(null);
  const [offline, setOffline] = useState(false);
  /** True when this is the sample the public preview ships, shown because no server answered. */
  const [sample, setSample] = useState(false);
  /** Whether the server has answered at all, and whether the sample has been fetched. */
  const seen = useRef({ live: false, sample: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState('me');
  const [showAudit, setShowAudit] = useState(false);
  /** What the manager clicked on the branch map: a prompt, a line, a stopped prompt, or a task. */
  const [pick, setPick] = useState<Pick>(null);
  /** A rule the manager just changed, shown at once while the server catches up. */
  const [draft, setDraft] = useState<Settings | null>(null);

  const load = () =>
    fetch('/api/manager')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((d: ManagerData) => {
        seen.current = { live: true, sample: false };
        setSample(false);
        setData(d);
        setOffline(false);
      })
      .catch(() => {
        // A server that was answering keeps its last page through a short gap, as before.
        if (seen.current.live || seen.current.sample) return;
        // No server at all: show the sample that ships with the preview, once, so clicks in it last.
        seen.current.sample = true;
        return fetch('/preview/manager.json')
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
          .then((d: ManagerData) => {
            setData(d);
            setSample(true);
          })
          .catch(() => {
            seen.current.sample = false;
            setOffline(true);
          });
      });

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, []);

  const decide = async (id: string, approved: boolean) => {
    if (sample) {
      // Nobody is waiting on the other side of a sample, so the request just leaves the list.
      setData((d) => (d ? { ...d, pending: d.pending.filter((p) => p.id !== id) } : d));
      return;
    }
    setBusy(id);
    await fetch(`/api/approvals/${id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    }).catch(() => {});
    await load();
    setBusy(null);
  };

  /** Change a rule for the whole team. It applies from each person's next prompt. */
  const setRule = async (change: Partial<Settings>) => {
    if (!data) return;
    if (sample) {
      setData({ ...data, settings: { ...data.settings, ...change } });
      return;
    }
    const next = { ...(draft ?? data.settings), ...change };
    setDraft(next);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...next, actor: 'manager' }),
    }).catch(() => {});
    await load();
    setDraft(null);
  };

  if (!data) {
    return (
      <main className="mgr">
        {offline ? (
          <>
            <header className="mgr__top">
              <div>
                <h1>
                  The manager's page <span>needs the Layers server</span>
                </h1>
                <p>
                  This preview runs without the server, so there is nothing live to show here. With it, this page has
                  approval requests and their reasons, the rules for the whole team, each person's progress and branch
                  map, and the audit trail. These two pictures are that page in the full build.
                </p>
              </div>
            </header>
            <img className="mgr__shot" src="/preview/manager-1.jpg" alt="The manager's page: an approval request with its reason, the rules, and the team." />
            <img className="mgr__shot" src="/preview/manager-2.jpg" alt="The manager's page: one person's update, activity, progress and branch map." />
          </>
        ) : (
          <p className="mgr__empty">Loading</p>
        )}
      </main>
    );
  }

  const member = data.team.find((m) => m.id === chosen) ?? data.team[0]!;
  const first = member.name.split(' ')[0];
  const done = member.tasks.filter((t) => t.status === 'done').length;
  const team = data.team[0]?.team ?? 'Your';
  const settings = draft ?? data.settings;
  const rule = (id: string) => data.rules.find((r) => r.id === id);

  return (
    <div className="root">
      <main className="mgr">
        <header className="mgr__top">
          <div>
            <h1>
              {team} team <span>AI workspace</span>
            </h1>
            <p>
              {data.manager}, managing {plural(data.team.length, 'person', 'people')}.
            </p>
          </div>
          <p className="mgr__who">
            <MascotGlyph shape="drop" />
            Layers
          </p>
        </header>

        {sample && (
          <p className="mgr__sample" role="note">
            This copy has no server behind it, so this page is a sample. Nothing on it is live, and what you change
            here is not kept. With the server, it fills in as the employee works.
          </p>
        )}

        <section aria-labelledby="needs">
          <h2 id="needs">Needs you{data.pending.length > 0 && <b>{data.pending.length}</b>}</h2>
          {data.pending.length === 0 ? (
            <p className="mgr__empty">Nothing is waiting on you.</p>
          ) : (
            data.pending.map((p) => (
              <article className="mgr__req" key={p.id}>
                <p className="mgr__meta">
                  <code>{p.id}</code> {p.from} wants to send this prompt
                </p>
                <blockquote>{p.prompt}</blockquote>
                <p className="mgr__why">
                  <b>Why Layers held it.</b> {p.reason}
                </p>
                {(p.signals.fits.length > 0 || p.signals.against.length > 0) && (
                  <dl className="b-signals">
                    {p.signals.fits.length > 0 && (
                      <div data-side="fits">
                        <dt>Fits {data.project.name}</dt>
                        {p.signals.fits.map((w) => (
                          <dd key={w}>{w}</dd>
                        ))}
                      </div>
                    )}
                    {p.signals.against.length > 0 && (
                      <div data-side="against">
                        <dt>Not in the brief</dt>
                        {p.signals.against.map((w) => (
                          <dd key={w}>{w}</dd>
                        ))}
                      </div>
                    )}
                  </dl>
                )}
                {p.note && (
                  <p className="mgr__note">
                    {p.from.split(' ')[0]}'s note: {p.note}
                  </p>
                )}
                <div className="mgr__acts">
                  <button type="button" className="act act--primary" disabled={busy === p.id} onClick={() => void decide(p.id, true)}>
                    Approve
                  </button>
                  <button type="button" className="act" disabled={busy === p.id} onClick={() => void decide(p.id, false)}>
                    Decline
                  </button>
                </div>
              </article>
            ))
          )}
        </section>

        <section aria-labelledby="rules">
          <h2 id="rules">
            Rules <span>for the whole team, from their next prompt</span>
          </h2>
          <div className="mgr__rules">
            <div className="mgr__rule">
              <p>
                <code>AI-01</code>
                <b>{rule('AI-01')?.name ?? 'Assigned work only'}.</b> When a prompt is off-project:
              </p>
              <Choice
                label="When a prompt is off-project"
                value={settings.policy_mode}
                options={POLICY}
                onChange={(policy_mode) => void setRule({ policy_mode })}
              />
            </div>
            <div className="mgr__rule">
              <p>
                <b>Unclear prompts.</b> When Layers cannot tell if a prompt is project work:
              </p>
              <Choice
                label="When Layers cannot tell"
                value={settings.unsure_mode}
                options={UNSURE}
                onChange={(unsure_mode) => void setRule({ unsure_mode })}
              />
            </div>
            <div className="mgr__rule">
              <p>
                <code>AI-02</code>
                <b>{rule('AI-02')?.name ?? 'Reuse before rebuild'}.</b> {rule('AI-02')?.text}
              </p>
              <span className="mgr__on">Always on</span>
            </div>
          </div>
        </section>

        <section aria-labelledby="team">
          <h2 id="team">Team</h2>
          <div className="mgr__team">
            {data.team.map((m) => {
              const finished = m.tasks.filter((t) => t.status === 'done').length;
              return (
                <button
                  key={m.id}
                  type="button"
                  className="mgr__member"
                  aria-pressed={m.id === member.id}
                  onClick={() => (setChosen(m.id), setPick(null))}
                >
                  <span className="mgr__name">
                    {m.name}
                    <span className="mgr__tag" data-live={m.sample ? undefined : ''}>
                      {m.sample ? 'Sample' : 'Live'}
                    </span>
                  </span>
                  <span className="mgr__proj">
                    {m.role}. <b>{m.project.name}</b> {m.project.title}
                  </span>
                  <span className="mgr__meter" aria-hidden="true">
                    <i style={{ width: `${(finished / Math.max(1, m.tasks.length)) * 100}%` }} />
                  </span>
                  <span className="mgr__line">
                    <span>
                      {finished} of {m.tasks.length} tasks done
                    </span>
                    {m.pending > 0 ? (
                      <span className="mgr__wait">{m.pending} waiting on you</span>
                    ) : (
                      <span>
                        {m.counts.checked} checked, {m.counts.held} held
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="person" key={member.id} className="mgr__person">
          <h2 id="person">
            {member.name}
            <span>
              {member.project.name}, {member.project.title.toLowerCase()}. Due {member.project.due}.
            </span>
          </h2>

          {member.updates && member.updates.length > 0 && (
            <div className="mgr__col">
              <h3>
                Updates from {first} <span>{first} read and approved each one before it was sent</span>
              </h3>
              <ul className="mgr__updates">
                {member.updates.map((u) => (
                  <li key={u.ts}>
                    <time>{clock(u.ts)}</time>
                    <p>{u.text}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mgr__cols">
            <div className="mgr__col">
              <h3>What happened</h3>
              <p className="mgr__counts">
                <span>
                  <b>{member.counts.checked}</b>checked
                </span>
                <span>
                  <b>{member.counts.passed}</b>went straight through
                </span>
                <span>
                  <b>{member.counts.held}</b>held
                </span>
                <span>
                  <b>{member.counts.reused}</b>reused
                </span>
              </p>
              {member.feed.length === 0 ? (
                <p className="mgr__empty">No activity yet in this session.</p>
              ) : (
                <ol className="mgr__feed" data-plain={member.sample ? '' : undefined}>
                  {member.feed.map((f, i) => (
                    <li key={`${f.ts ?? 's'}-${i}`}>
                      {f.ts != null && <time>{clock(f.ts)}</time>}
                      <span>{f.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="mgr__col">
              <h3>
                Progress{' '}
                <span>
                  {done} of {member.tasks.length} done
                </span>
              </h3>
              <ul className="proj__tasks mgr__tasks">
                {member.tasks.map((t) => {
                  const lines = member.branches?.lines.filter((l) => l.task === t.id) ?? [];
                  const prompts = member.branches?.nodes.filter((n) => lines.some((l) => l.id === n.line)).length ?? 0;
                  return (
                    <li key={t.id} data-status={t.status}>
                      <span className="proj__mark" aria-hidden="true">
                        {t.status === 'done' && <Check />}
                      </span>
                      <button
                        type="button"
                        className="mgr__task"
                        aria-pressed={pick?.kind === 'task' && pick.id === t.id}
                        title="Show where this task is on the branch map"
                        onClick={() => setPick(pick?.kind === 'task' && pick.id === t.id ? null : { kind: 'task', id: t.id })}
                      >
                        {t.title}
                      </button>
                      <em>
                        {t.status === 'doing' ? 'In progress' : ''}
                        {lines.length > 0 ? `${t.status === 'doing' ? ', ' : ''}${plural(prompts, 'prompt', 'prompts')}` : ''}
                      </em>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="mgr__col">
            <h3>
              Branches <span>how {first}'s conversation has split</span>
            </h3>
            {member.branches ? (
              <>
                <BranchMap
                  shape={member.branches}
                  size="small"
                  picked={pick?.kind === 'node' ? pick.i : null}
                  onPick={(i) => setPick(i === null ? null : { kind: 'node', i })}
                  describe={(i) => `Prompt ${i + 1}`}
                  pickedStop={pick?.kind === 'stop' ? pick.k : null}
                  onPickStop={(k) => setPick(k === null ? null : { kind: 'stop', k })}
                  onPickLine={(id) => setPick(pick?.kind === 'line' && pick.id === id ? null : { kind: 'line', id })}
                  focus={
                    pick?.kind === 'line'
                      ? [pick.id]
                      : pick?.kind === 'task'
                        ? member.branches.lines.filter((l) => l.task === pick.id).map((l) => l.id)
                        : pick?.kind === 'node'
                          ? [member.branches.nodes[pick.i]?.line ?? '']
                          : undefined
                  }
                />
                <Detail pick={pick} shape={member.branches} tasks={member.tasks} first={first ?? ''} onPick={setPick} />
                <p className="mgr__empty">
                  {describe(member.branches)} A dot is a prompt, a number marks coming back to a line, and a red dead
                  end is a prompt that was stopped. Each line is named by the part of the project it is on. What{' '}
                  {first} typed is not shown.
                </p>
              </>
            ) : (
              <p className="mgr__empty">No branch map yet. It appears once {first}'s workspace is open.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="ways">
          <h2 id="ways">
            How the team works <span>the steps people took and what they reused. Layers offers these to teammates</span>
          </h2>
          <ul className="mgr__ways">
            {data.processes.map((p, i) => (
              <li key={`${p.who}-${p.project}-${i}`}>
                <p>
                  <b>{p.who}</b> on {p.project}
                  <span className="mgr__tag" data-live={p.sample ? undefined : ''}>
                    {p.sample ? 'Sample' : 'Live'}
                  </span>
                  <time>{p.when}</time>
                </p>
                <p className="mgr__empty">{p.did}.</p>
                <p className="b-path">
                  {p.path.map((step) => (
                    <span key={step}>{step}</span>
                  ))}
                </p>
                {p.workflow && (
                  <p className="mgr__empty">
                    Used <code>{p.workflow}</code>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="audit">
          <h2 id="audit">
            Audit trail <span>every check, tool call and decision</span>
            <button type="button" className="mgr__more" aria-expanded={showAudit} onClick={() => setShowAudit((s) => !s)}>
              {showAudit ? 'Hide' : `Show the last ${data.audit.length}`}
            </button>
          </h2>
          {showAudit &&
            (data.audit.length === 0 ? (
              <p className="mgr__empty">Nothing has been logged yet in this session.</p>
            ) : (
              <ol className="mgr__audit">
                {data.audit.map((row, i) => (
                  <li key={`${row.ts}-${i}`}>
                    <time>{stamp(row.ts)}</time>
                    <b>{row.who}</b>
                    <span>{row.what}</span>
                    <code>{row.note}</code>
                  </li>
                ))}
              </ol>
            ))}
          {showAudit && <p className="mgr__empty">Who did what, and how long each tool call took. What was typed is left out.</p>}
        </section>

        <p className="mgr__fine">
          You see a prompt only when someone sends it to you for approval. Everything else appears as counts, outcomes
          and the shape of the conversation.{' '}
          {sample
            ? 'Everyone on this page is example data.'
            : `${data.team.filter((m) => !m.sample).map((m) => m.name.split(' ')[0]).join(', ')} is live. Teammates marked Sample are example data, there to show how a team looks.`}{' '}
          The company and people are fictional.
        </p>
      </main>
      <EdgeGlow mode={data.pending.length > 0 ? 'unsure' : 'ambient'} variant="glow" quiet={false} />
    </div>
  );
}
