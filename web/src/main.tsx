import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@radix-ui/themes/styles.css';
import './styles.css';

import { Theme } from '@radix-ui/themes';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initToken } from './api';
import { App } from './App';

initToken();

/** Follows the operating system's light or dark setting, live. */
function useSystemAppearance(): 'light' | 'dark' {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(query.matches);
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  return dark ? 'dark' : 'light';
}

function Root() {
  const appearance = useSystemAppearance();
  return (
    <Theme appearance={appearance} accentColor="cyan" grayColor="slate" radius="medium" scaling="100%">
      <App />
    </Theme>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
