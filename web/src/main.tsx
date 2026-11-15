import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/martian-mono/wdth.css';
import './styles/tokens.css';
import './styles/workspace.css';
import './styles/layers.css';
import './styles/lab.css';
import App from './App';
import { ManagerView } from './manager/ManagerView';
import './styles/manager.css';

type View = 'employee' | 'manager' | 'both';

const viewOf = (hash: string): View => (hash === '#manager' ? 'manager' : hash === '#both' ? 'both' : 'employee');
const embedded = window.self !== window.top;

const VIEWS: [View, string, string][] = [
  ['employee', '#', 'Employee'],
  ['manager', '#manager', 'Manager'],
  ['both', '#both', 'Side by side'],
];

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
        <App />
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
            <a key={name} href={href} aria-current={view === name ? 'page' : undefined}>
              {label}
            </a>
          ))}
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
