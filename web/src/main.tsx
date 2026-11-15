import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/martian-mono/wdth.css';
import './styles/tokens.css';
import './styles/workspace.css';
import './styles/layers.css';
import './styles/branches.css';
import './styles/bubble-extra.css';
import App from './App';
import { ManagerView } from './manager/ManagerView';
import './styles/manager.css';
import { TRY_EVENT, TRY_OPEN, TRY_PROMPTS, type TryItem } from './workspace/tries';

type View = 'employee' | 'manager' | 'both';

const viewOf = (hash: string): View => (hash === '#manager' ? 'manager' : hash === '#both' ? 'both' : 'employee');
const embedded = window.self !== window.top;

const VIEWS: [View, string, string][] = [
  ['employee', '#', 'Employee'],
  ['manager', '#manager', 'Manager'],
  ['both', '#both', 'Side by side'],
];

/** The demo's examples, one click each. Every one plays in the employee's workspace. */
function TryMenu({ view }: { view: View }) {
  const [open, setOpen] = useState(false);
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
    setOpen(false);
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
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" onClick={() => play(item.id)}>
          <b>{item.label}</b>
          <span>{item.hint}</span>
        </button>
      ))}
    </>
  );

  return (
    <>
      <button type="button" className="views__try" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Try it
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
 * One address, three views. The employee's workspace stays mounted while the manager's
 * view is showing, so a request sent for approval is still there when you hop back.
 */
function Root() {
  const [view, setView] = useState<View>(viewOf(window.location.hash));
  useEffect(() => {
    const onChange = () => setView(viewOf(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return (
    <>
      <div style={{ display: view === 'employee' ? 'contents' : 'none' }}>
        <App active={view === 'employee'} />
      </div>
      {view === 'manager' && <ManagerView />}
      {view === 'both' && (
        <div className="split">
          <iframe title="Employee workspace" src="/" />
          <iframe title="Manager view" src="/#manager" />
        </div>
      )}
      {!embedded && (
        <nav className="views" data-view={view} aria-label="Demo view">
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
