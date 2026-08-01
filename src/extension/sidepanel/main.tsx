import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/globals.css';
import { App } from './App';
import { LocaleProvider } from '@extension/ui/locale-context';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing root element');
}

createRoot(root).render(
  <React.StrictMode>
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </React.StrictMode>,
);
