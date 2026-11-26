import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getWebRuntimeConfig, isWebRuntime } from './core/ipc';
import { bootstrapLightermKernel } from './plugins';
import './index.css';

// Activate built-in plugins and default drawer layout synchronously before first React paint,
// unless running in Web mode behind an unauthenticated login gate.
const webBoot = getWebRuntimeConfig();
if (!(isWebRuntime() && webBoot?.authRequired && !webBoot.authenticated)) {
  void bootstrapLightermKernel();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
