import { create } from 'zustand';
import { invokeTauri, isTauriRuntime, listenTauri } from './ipc';

export type DesktopPlatform = 'windows' | 'macos' | 'linux';

export interface WindowStoreState {
  platform: DesktopPlatform;
  maximized: boolean;
  focused: boolean;
}

interface BackendWindowState {
  platform?: string;
  maximized: boolean;
  focused: boolean;
}

export function detectPlatformFromEnv(userAgent?: string): DesktopPlatform {
  const ua =
    userAgent ??
    (typeof navigator !== 'undefined' ? `${navigator.userAgent ?? ''} ${navigator.platform ?? ''}` : '');
  if (/mac|iphone|ipad|ipod/i.test(ua)) return 'macos';
  if (/linux/i.test(ua)) return 'linux';
  return 'windows';
}

function normalizeBackendPlatform(raw?: string): DesktopPlatform | null {
  if (raw === 'macos' || raw === 'darwin') return 'macos';
  if (raw === 'linux') return 'linux';
  if (raw === 'windows') return 'windows';
  return null;
}

export const useWindowStore = create<WindowStoreState>(() => ({
  platform: detectPlatformFromEnv(),
  maximized: false,
  focused: true,
}));

type BeforeWindowCloseListener = () => Promise<void> | void;

let initPromise: Promise<void> | null = null;
let unlistenWindowState: (() => void) | null = null;
const beforeWindowCloseListeners = new Set<BeforeWindowCloseListener>();

export const windowControls = {
  async initialize(): Promise<void> {
    if (!isTauriRuntime()) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        const state = await invokeTauri<BackendWindowState>('window_get_state');
        const platform = normalizeBackendPlatform(state.platform) ?? useWindowStore.getState().platform;
        useWindowStore.setState({
          platform,
          maximized: Boolean(state.maximized),
          focused: state.focused ?? true,
        });
      } catch {
        // Ignore if backend window state is unavailable
      }

      try {
        unlistenWindowState = await listenTauri<BackendWindowState>(
          'window:state-changed',
          (payload) => {
            useWindowStore.setState({
              maximized: Boolean(payload.maximized),
              focused: payload.focused ?? true,
            });
          },
        );
      } catch {
        // Ignore event subscription errors outside full Tauri runtime
      }
    })();

    return initPromise;
  },

  minimize(): void {
    if (!isTauriRuntime()) return;
    void invokeTauri<void>('window_minimize').catch(() => {});
  },

  async toggleMaximize(): Promise<void> {
    if (!isTauriRuntime()) {
      useWindowStore.setState((s) => ({ maximized: !s.maximized }));
      return;
    }
    try {
      const nextMaximized = await invokeTauri<boolean>('window_toggle_maximize');
      useWindowStore.setState({ maximized: Boolean(nextMaximized) });
    } catch {
      // Ignore maximize toggle failures
    }
  },

  registerBeforeWindowClose(listener: BeforeWindowCloseListener): () => void {
    beforeWindowCloseListeners.add(listener);
    return () => {
      beforeWindowCloseListeners.delete(listener);
    };
  },

  close(): void {
    if (!isTauriRuntime()) {
      for (const listener of beforeWindowCloseListeners) {
        try {
          void listener();
        } catch {
          // Ignore before-close errors
        }
      }
      return;
    }
    void (async () => {
      for (const listener of beforeWindowCloseListeners) {
        try {
          await listener();
        } catch {
          // Ignore before-close errors
        }
      }
      await invokeTauri<void>('window_close').catch(() => {});
    })();
  },

  startDragging(): void {
    if (!isTauriRuntime()) return;
    void invokeTauri<void>('window_start_dragging').catch(() => {});
  },

  setPlatformForTesting(platform: DesktopPlatform): void {
    useWindowStore.setState({ platform });
  },

  resetForTesting(): void {
    initPromise = null;
    unlistenWindowState?.();
    unlistenWindowState = null;
    beforeWindowCloseListeners.clear();
    useWindowStore.setState({
      platform: detectPlatformFromEnv(),
      maximized: false,
      focused: true,
    });
  },
};
