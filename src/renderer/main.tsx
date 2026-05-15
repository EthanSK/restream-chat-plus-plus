import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';

const el = document.getElementById('root');
if (!el) throw new Error('No #root element');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
