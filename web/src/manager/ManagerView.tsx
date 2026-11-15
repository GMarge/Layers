import { useEffect, useState } from 'react';
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
  return `${parts.join('. ')}.`;
}

export function ManagerView() {
  const [data, setData] = useState<ManagerData | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState('jordan');
  const [showAudit, setShowAudit] = useState(false);
  /** A rule the manager just changed, shown at once while the server catches up. */
  const [draft, setDraft] = useState<Settings | null>(null);

  const load = () =>
    fetch('/api/manager')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unavailable'))))
      .then((d: ManagerData) => {
        setData(d);
        setOffline(false);
      })
      .catch(() => setOffline(true));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, []);

  const decide = async (id: string, approved: boolean) => {
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
        <p className="mgr__empty">{offline ? 'The Layers server is not running.' : 'Loading'}</p>
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
                  onClick={() => setChosen(m.id)}
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
                {member.tasks.map((t) => (
                  <li key={t.id} data-status={t.status}>
                    <span className="proj__mark" aria-hidden="true">
                      {t.status === 'done' && <Check />}
                    </span>
                    <span>{t.title}</span>
                    {t.status === 'doing' && <em>In progress</em>}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mgr__col">
            <h3>
              Branches <span>how {first}'s conversation has split</span>
            </h3>
            {member.branches ? (
              <>
                <BranchMap shape={member.branches} size="small" />
                <p className="mgr__empty">
                  {describe(member.branches)} A dot is a prompt, and a number marks coming back to a line. Each line is
                  named by the part of the project it is on. What {first} typed is not shown.
                </p>
              </>
            ) : (
              <p className="mgr__empty">No branch map yet. It appears once {first}'s workspace is open.</p>
            )}
          </div>
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
          and the shape of the conversation. {data.team.filter((m) => !m.sample).map((m) => m.name.split(' ')[0]).join(', ')}{' '}
          is live. Teammates marked Sample are example data, there to show how a team looks. The company and people are
          fictional.
        </p>
      </main>
      <EdgeGlow mode={data.pending.length > 0 ? 'unsure' : 'ambient'} variant="glow" quiet={false} />
    </div>
  );
}
