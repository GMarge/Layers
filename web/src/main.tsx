import { StrictMode, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/martian-mono/wdth.css';
import './styles/tokens.css';
import './styles/workspace.css';
import './styles/layers.css';
import './styles/branches.css';
import './styles/bubble-extra.css';
import App from './App';
import { Intro } from './intro/Intro';
import { ManagerView } from './manager/ManagerView';
import './styles/manager.css';
import './styles/intro.css';
import { TRY_EVENT, TRY_OPEN, TRY_PROMPTS, type TryItem } from './workspace/tries';

type View = 'employee' | 'manager' | 'both' | 'intro';

const viewOf = (hash: string): View =>
  hash === '#manager' ? 'manager' : hash === '#both' ? 'both' : hash === '#intro' ? 'intro' : 'employee';
const embedded = window.self !== window.top;

const VIEWS: [View, string, string][] = [
  ['employee', '#', 'Employee'],
  ['manager', '#manager', 'Manager'],
  ['both', '#both', 'Side by side'],
];

/** The demo's examples, one click each. Every one plays in the employee's workspace. */
function TryMenu({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
  /** Today's model runs, read when the menu opens. Null when there is no server to ask, undefined until it answers. */
  const [runs, setRuns] = useState<{ used: number; cap: number } | null | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((settings: { runs?: { used: number; cap: number } } | null) => setRuns(settings?.runs ?? null))
      .catch(() => setRuns(null));
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.views__try, .views__menu')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  const play = (id: string) => {
    if (id === 'runs') {
      // A copy with no server has no model and no count, so there is nothing to do.
      if (!runs) return;
      // The menu stays open, so the count going back to zero is the confirmation.
      void fetch('/api/runs/reset', { method: 'POST' })
        .then((r) => (r.ok ? r.json() : null))
        .then((now: { used: number; cap: number } | null) => now && setRuns(now))
        .catch(() => {});
      return;
    }
    setOpen(false);
    if (id === 'intro') {
      window.location.hash = '#intro';
      return;
    }
    const fire = () => {
      // Side by side, the workspace is the frame on the left.
      const frame = document.querySelector<HTMLIFrameElement>('.split iframe');
      (frame?.contentWindow ?? window).dispatchEvent(new CustomEvent(TRY_EVENT, { detail: id }));
    };
    if (view === 'manager') {
      window.location.hash = '';
      setTimeout(fire, 300);
    } else fire();
  };

  const group = (title: string, items: TryItem[]) => (
    <>
      <p>{title}</p>
      {items.map((item) => {
        // The count lives on the server. A copy without one says so, instead of leaving the item out.
        const none = item.id === 'runs' && runs === null;
        const hint =
          item.id !== 'runs' || runs === undefined
            ? item.hint
            : runs
              ? `${runs.used} of ${runs.cap} used today. Sets it back to zero.`
              : 'Not on this copy. It has no model, so no runs are counted.';
        return (
          <button key={item.id} type="button" role="menuitem" aria-disabled={none || undefined} onClick={() => play(item.id)}>
            <b>{item.label}</b>
            <span>{hint}</span>
          </button>
        );
      })}
    </>
  );

  /** Start the whole demo over: chats, branches, requests, updates and rules, for every view. */
  const refresh = async () => {
    await fetch('/api/reset', { method: 'POST' }).catch(() => {});
    try {
      localStorage.removeItem('layers.session.v1');
    } catch {
      // Nothing was saved, so there is nothing to clear.
    }
    window.location.reload();
  };

  return (
    <>
      <button type="button" className="views__try" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Try it
      </button>
      <button
        type="button"
        className="views__refresh"
        title="Refresh: start the demo over with a clean workspace"
        aria-label="Refresh. Start the demo over with a clean workspace"
        onClick={() => void refresh()}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path
            d="M11.6 7a4.6 4.6 0 1 1-1.4-3.3M11.8 1.6v2.6H9.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>Refresh</span>
      </button>
      {open && (
        <div className="views__menu" role="menu" aria-label="Examples to try">
          {group('Plays itself', TRY_PROMPTS)}
          {group('Opens', TRY_OPEN)}
        </div>
      )}
    </>
  );
}

/**
 * One address, three views and the idle screen. The employee's workspace stays mounted while
 * the manager's view is showing, so a request sent for approval is still there when you hop back.
 *
 * The idle screen stands alone: the bar that drives the demo is not on it, and pops in once
 * the demo has started.
 */
function Root() {
  const [view, setView] = useState<View>(viewOf(window.location.hash));
  /** True when the demo was just entered from the idle screen, so the bar pops in instead of simply being there. */
  const [entered, setEntered] = useState(false);
  const shown = useRef(view);
  useEffect(() => {
    const onChange = () => {
      const next = viewOf(window.location.hash);
      const from = shown.current;
      if (next === from) return;
      shown.current = next;
      const apply = () => {
        setEntered(from === 'intro');
        setView(next);
      };
      // Into and out of the idle screen the page cross-fades instead of cutting, where the browser can.
      const glide = (document as unknown as { startViewTransition?: (run: () => void) => unknown }).startViewTransition;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if ((from === 'intro' || next === 'intro') && typeof glide === 'function' && !still) {
        glide.call(document, () => flushSync(apply));
      } else apply();
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return (
    <>
      <div style={{ display: view === 'employee' ? 'contents' : 'none' }}>
        <App active={view === 'employee'} />
      </div>
      {view === 'manager' && <ManagerView />}
      {view === 'intro' && <Intro />}
      {view === 'both' && (
        <div className="split">
          <iframe title="Employee workspace" src="/" />
          <iframe title="Manager view" src="/#manager" />
        </div>
      )}
      {!embedded && view !== 'intro' && (
        <nav className="views" data-view={view} data-pop={entered ? '' : undefined} aria-label="Demo view">
          {VIEWS.map(([name, href, label]) => (
            <a key={name} href={href} data-view={name} aria-current={view === name ? 'page' : undefined}>
              {label}
            </a>
          ))}
          <TryMenu view={view} />
        </nav>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
