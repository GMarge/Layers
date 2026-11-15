import { useEffect, useState } from 'react';
import { EdgeGlow } from '../layers/EdgeGlow';
import { MascotGlyph } from '../layers/Mascot';
import type { Signals, Task } from '../layers/types';
import { Check } from '../ui/icons';

/**
 * The manager's side of Layers. It shows a prompt only when the employee sent it for
 * approval. Everything else is counts and outcomes, never what was typed.
 */

interface Pending {
  id: string;
  prompt: string;
  note: string;
  reason: string;
  signals: Signals;
  from: string;
}

interface ManagerData {
  manager: string;
  employee: { name: string; role: string; team: string };
  project: { name: string; title: string; due: string };
  pending: Pending[];
  feed: { ts: number; text: string }[];
  tasks: Task[];
  counts: { checked: number; passed: number; held: number; reused: number };
}

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function ManagerView() {
  const [data, setData] = useState<ManagerData | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

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

  if (!data) {
    return (
      <main className="mgr">
        <p className="mgr__empty">{offline ? 'The Layers server is not running.' : 'Loading'}</p>
      </main>
    );
  }

  const first = data.employee.name.split(' ')[0];
  const done = data.tasks.filter((t) => t.status === 'done').length;

  return (
    <div className="root">
      <main className="mgr">
        <header className="mgr__top">
          <div>
            <h1>
              {data.project.name} <span>{data.project.title}</span>
            </h1>
            <p>
              {data.manager}, managing {data.employee.name}. Due {data.project.due}.
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
                    {first}'s note: {p.note}
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

        <div className="mgr__cols">
          <section aria-labelledby="happened">
            <h2 id="happened">What happened</h2>
            <p className="mgr__counts">
              <span>
                <b>{data.counts.checked}</b>checked
              </span>
              <span>
                <b>{data.counts.passed}</b>went straight through
              </span>
              <span>
                <b>{data.counts.held}</b>held
              </span>
              <span>
                <b>{data.counts.reused}</b>reused
              </span>
            </p>
            {data.feed.length === 0 ? (
              <p className="mgr__empty">No activity yet in this session.</p>
            ) : (
              <ol className="mgr__feed">
                {data.feed.map((f, i) => (
                  <li key={`${f.ts}-${i}`}>
                    <time>{clock(f.ts)}</time>
                    <span>{f.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="progress">
            <h2 id="progress">
              Progress <span>{done} of {data.tasks.length} done</span>
            </h2>
            <ul className="proj__tasks mgr__tasks">
              {data.tasks.map((t) => (
                <li key={t.id} data-status={t.status}>
                  <span className="proj__mark" aria-hidden="true">
                    {t.status === 'done' && <Check />}
                  </span>
                  <span>{t.title}</span>
                  {t.status === 'doing' && <em>In progress</em>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <p className="mgr__fine">
          You see a prompt only when {first} sends it to you for approval. Everything else appears as counts and
          outcomes. Demo data: the company and people are fictional.
        </p>
      </main>
      <EdgeGlow mode={data.pending.length > 0 ? 'unsure' : 'ambient'} variant="glow" quiet={false} />
    </div>
  );
}
