import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Artifact, Hold, Message, Task } from '../layers/types';
import { ArrowUp, Check, Chevron } from '../ui/icons';
import { company, conversations, employee, project, rules } from './data';

/**
 * The company's AI workspace: the product Layers manages. It is deliberately
 * quiet and neutral so that everything blue on screen is Layers.
 */

interface Props {
  messages: Message[];
  tasks: Task[];
  draft: string;
  hold: Hold | null;
  busy: boolean;
  setAside: string | null;
  layout: 'sidebar' | 'focus';
  /** The Layers agent is melted into the chat box, so the box wears its outline. */
  layersIn: boolean;
  /** The employee has hidden the agent. It still checks prompts, so the page says so. */
  layersHidden: boolean;
  onShowLayers(): void;
  /** Room Layers needs above the chat box. The thread leaves it free. */
  reserve: number;
  sidebarSlot?: ReactNode;
  /** The conversation map, shown under the top bar. */
  railSlot?: ReactNode;
  onDraftChange(text: string): void;
  onSend(): void;
  onReview(): void;
  onRestore(): void;
  onOpenRules(): void;
}

function ProjectChip({ tasks }: { tasks: Task[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const done = tasks.filter((t) => t.status === 'done').length;
  const doing = tasks.filter((t) => t.status === 'doing').length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="proj" ref={ref}>
      <button
        type="button"
        className="proj__chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <b>{project.name}</b>
        <span className="proj__title">{project.title}</span>
        <span className="proj__count" key={`${done}-${doing}`}>
          {done} done, {doing} in progress
        </span>
        <Chevron />
      </button>
      {open && (
        <div className="proj__pop" role="dialog" aria-label={`${project.name} brief`}>
          <p className="proj__head">
            <b>{project.name}</b> {project.title}
          </p>
          <p className="proj__meta">
            Assigned by {project.assignedBy}. Due {project.due}.
          </p>
          <ul className="proj__tasks">
            {tasks.map((t) => (
              <li key={t.id} data-status={t.status}>
                <span className="proj__mark" aria-hidden="true">
                  {t.status === 'done' && <Check />}
                </span>
                <span>{t.title}</span>
                {t.status === 'doing' && <em>In progress</em>}
              </li>
            ))}
          </ul>
          <p className="proj__sub">Workspace rules</p>
          <ul className="proj__rules">
            {rules.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Sheet({ artifact }: { artifact: Artifact }) {
  return (
    <figure className="sheet" id={`artifact-${artifact.id}`}>
      <figcaption className="sheet__head">
        <b>{artifact.title}</b>
        <span>
          From {artifact.source} by {artifact.author}
        </span>
      </figcaption>
      <div className="sheet__scroll">
        <table>
          <thead>
            <tr>
              {artifact.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifact.rows.map((row) => (
              <tr key={row[0]}>
                {row.map((cell, i) =>
                  i === 0 ? (
                    <th key={i} scope="row">
                      {cell}
                    </th>
                  ) : (
                    <td key={i}>{cell}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** Bold, code and emphasis inside one line of a model answer. Built as elements, never as HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

/** A model answer with its paragraphs, headings and lists laid out. */
function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let items: { ordered: boolean; rows: string[] } | null = null;
  const flush = () => {
    if (!items) return;
    const List = items.ordered ? 'ol' : 'ul';
    blocks.push(
      <List key={blocks.length} className="msg__md-list">
        {items.rows.map((row, i) => (
          <li key={i}>{inline(row)}</li>
        ))}
      </List>,
    );
    items = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]!);
      if (!items || items.ordered !== ordered) {
        flush();
        items = { ordered, rows: [] };
      }
      items.rows.push(bullet[2]!);
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={blocks.length} className="msg__text msg__md-head">
          {inline(heading[1]!)}
        </p>
      ) : (
        <p key={blocks.length} className="msg__text">
          {inline(line)}
        </p>
      ),
    );
  }
  flush();
  return <div className="msg__md">{blocks}</div>;
}

function MessageRow({ message: m }: { message: Message }) {
  if (m.role === 'user')
    return (
      <div className="msg msg--user" data-seq={m.seq ?? 0}>
        {m.text}
      </div>
    );

  if (m.role === 'layers') {
    return (
      <div className="msg msg--layers">
        <p className="msg__who">
          <span className="msg__mark" aria-hidden="true" />
          Layers
        </p>
        {m.text && <p className="msg__text">{m.text}</p>}
        {m.artifact && <Sheet artifact={m.artifact} />}
      </div>
    );
  }

  return (
    <div className="msg msg--ai">
      <p className="msg__who">{company.assistant}</p>
      {m.placeholder ? <p className="msg__text msg__text--quiet">{m.text}</p> : <Rich text={m.text ?? ''} />}
      {m.list && (
        <ol className="msg__list">
          {m.list.map((item, n) => (
            <li key={item.name}>
              <span className="msg__n">{n + 1}</span>
              <span>
                <b>{item.name}</b> {item.note}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Workspace(p: Props) {
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [p.messages.length]);

  // When Layers needs room above the chat box, move the thread out of its way at once.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.reserve]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      p.onSend();
    }
  };

  const pending = p.hold?.kind === 'pending';

  return (
    <div className="app" data-layout={p.layout}>
      <aside className="side">
        <p className="side__brand">
          <span className="side__glyph" aria-hidden="true">
            F
          </span>
          {company.assistant}
        </p>
        <nav className="side__nav" aria-label="Conversations">
          <p className="side__label">Recent</p>
          <ul>
            {conversations.map((title, i) => (
              <li key={title} aria-current={i === 0 ? 'page' : undefined}>
                {title}
              </li>
            ))}
          </ul>
        </nav>
        {p.sidebarSlot}
        <div className="side__foot">
          <p className="side__user">
            <span className="side__avatar" aria-hidden="true">
              {employee.initials}
            </span>
            <span>
              <b>{employee.name}</b>
              <span>{employee.role}</span>
            </span>
          </p>
          <p className="side__fine">Demo workspace. The company, people and data are fictional.</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{conversations[0]}</h1>
          <ProjectChip tasks={p.tasks} />
        </header>
        {p.railSlot}

        <div className="thread" ref={threadRef}>
          <div className="thread__col">
            {p.messages.map((m) => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        </div>

        <div className="dock">
          <form
            id="composer"
            className="composer"
            data-hold={p.hold?.kind}
            data-layers={p.layersIn ? 'in' : undefined}
            onSubmit={(e) => {
              e.preventDefault();
              p.onSend();
            }}
          >
            {p.hold && (
              <div className="composer__hold" data-kind={p.hold.kind}>
                <span className="composer__dot" aria-hidden="true" />
                <span>{p.hold.label}</span>
                <button type="button" onClick={p.onReview}>
                  Review
                </button>
              </div>
            )}
            <div className="composer__row">
              <textarea
                id="prompt"
                rows={1}
                value={p.draft}
                readOnly={pending}
                placeholder={`Ask about ${project.name}`}
                aria-label={`Message ${company.assistant}`}
                onChange={(e) => p.onDraftChange(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <button
                type="submit"
                className="composer__send"
                aria-label="Send"
                disabled={p.busy || pending || !p.draft.trim()}
              >
                <ArrowUp />
              </button>
            </div>
          </form>
          <p className="dock__note">
            {p.setAside ? (
              <>
                One draft set aside.{' '}
                <button type="button" onClick={p.onRestore}>
                  Restore it
                </button>
              </>
            ) : p.layersHidden ? (
              <>
                Layers is hidden and still checks each prompt when you press Send.{' '}
                <button type="button" onClick={p.onShowLayers}>
                  Show it
                </button>{' '}
                (Alt L)
              </>
            ) : (
              <>
                Layers checks each prompt against your project and the workspace rules when you press Send.{' '}
                <button type="button" onClick={p.onOpenRules}>
                  See the rules
                </button>
              </>
            )}
          </p>
        </div>
      </main>
    </div>
  );
}
