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

/** The manager's page lives at #manager. Everything else is the employee's workspace. */
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash === '#manager' ? <ManagerView /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
