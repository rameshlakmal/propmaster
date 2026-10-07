import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@radix-ui/themes/styles.css';
import './styles.css';

import { Theme } from '@radix-ui/themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initToken } from './api';
import { App } from './App';
import { useSystemAppearance } from './hooks';

initToken();

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
