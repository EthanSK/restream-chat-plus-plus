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
// The escape-hatch "Open Restream webchat" button on the inline send bar
// covers the only remaining differentiated use case (emoji picker /
// per-platform targeting / cookie refresh via the official Restream UI).

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
