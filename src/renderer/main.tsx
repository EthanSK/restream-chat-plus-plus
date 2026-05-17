import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { ComposeApp } from './ComposeApp';
import { ErrorBoundary } from './ErrorBoundary';

const el = document.getElementById('root');
if (!el) throw new Error('No #root element');

// v0.1.32: the same renderer bundle drives both the main window and the
// Compose window. Main process loads us with `?compose=1` for Compose, and
// we mount the lightweight <ComposeApp> instead of the full <App>.
const params = new URLSearchParams(window.location.search);
const isCompose = params.get('compose') === '1';

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isCompose ? <ComposeApp /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
