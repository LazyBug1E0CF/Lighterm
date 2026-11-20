export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function listenTauri<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<T>(event, (ev) => handler(ev.payload));
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
