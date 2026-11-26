import {
  invokeWebRpc,
  listenWebEvent,
  type WebRuntimeConfig,
} from './webTransport';

declare global {
  interface Window {
    __LIGHTERM_WEB__?: WebRuntimeConfig;
  }
}

export type RuntimeMode = 'tauri' | 'web' | 'preview';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function getWebRuntimeConfig(): WebRuntimeConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = window.__LIGHTERM_WEB__;
  return raw && typeof raw === 'object' ? raw : null;
}

export function isWebRuntime(): boolean {
  if (isTauriRuntime()) return false;
  if (getWebRuntimeConfig()?.mode === 'web') return true;
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.MODE === 'web' || env?.VITE_LIGHTERM_RUNTIME === 'web';
}

export function hasBackendRuntime(): boolean {
  return isTauriRuntime() || isWebRuntime();
}

export function getRuntimeMode(): RuntimeMode {
  if (isTauriRuntime()) return 'tauri';
  if (isWebRuntime()) return 'web';
  return 'preview';
}

export async function invokeBackend<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
  if (isWebRuntime()) {
    return invokeWebRpc<T>(cmd, args);
  }
  throw new Error(`invokeBackend('${cmd}') called without an active desktop or web backend`);
}

export async function listenBackend<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isTauriRuntime()) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(event, (ev) => handler(ev.payload));
  }
  if (isWebRuntime()) {
    return listenWebEvent<T>(event, handler);
  }
  return () => {};
}

export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeBackend<T>(cmd, args);
}

export async function listenTauri<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return listenBackend<T>(event, handler);
}

export async function pickOpenFile(title: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ title, multiple: false, directory: false });
  return typeof selected === 'string' ? selected : null;
}

export async function pickSaveFile(title: string, defaultName: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  const selected = await save({ title, defaultPath: defaultName });
  return typeof selected === 'string' ? selected : null;
}

export function pickBrowserFile(accept?: string): Promise<File | null> {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) {
      input.accept = accept;
    }
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', handleFocusBack);
      input.remove();
      resolve(file);
    };

    const handleFocusBack = () => {
      setTimeout(() => {
        if (!settled && (!input.files || input.files.length === 0)) {
          finish(null);
        }
      }, 300);
    };

    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      finish(null);
    });
    window.addEventListener('focus', handleFocusBack, { once: true });

    document.body.appendChild(input);
    input.click();
  });
}

export function readLs<T>(key: string, fallback: () => T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      const val = fallback();
      window.localStorage.setItem(key, JSON.stringify(val));
      return val;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback();
  }
}

export function writeLs<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors in headless environments
  }
}

export function makeUuid(prefix?: string): string {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return prefix ? `${prefix}-${raw}` : raw;
}
