import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';

const el = document.getElementById('root');
if (!el) throw new Error('No #root element');

// v0.1.34: the separate native <ComposeApp> (v0.1.32-v0.1.33) was removed.
// It rendered a near-duplicate of the inline send input and called the
// SAME `rcpp.sendChatText` IPC, so any send-path bug also broke Compose.
// v0.1.40: the "Open Restream webchat" escape-hatch button next to the
// inline send arrow was also removed now that inline send works
// end-to-end via Restream's `/api/client/reply` endpoint (v0.1.34+).

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
