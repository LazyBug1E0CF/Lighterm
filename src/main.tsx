import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { bootstrapLightermHarness } from './plugins';
import './index.css';

// Activate built-in plugins and default drawer layout synchronously before first React paint.
void bootstrapLightermHarness();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
