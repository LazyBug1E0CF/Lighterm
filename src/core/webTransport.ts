import { create } from 'zustand';

export interface WebAppSettings {
  allowLocalShell: boolean;
}

export interface WebRuntimeConfig {
  mode: 'web';
  version?: string;
  authRequired: boolean;
  usernameRequired: boolean;
  authenticated: boolean;
  localShellEnabled: boolean;
  selfUpdateEnabled?: boolean;
}

export type WsConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface WebAuthState {
  authRequired: boolean;
  usernameRequired: boolean;
  authenticated: boolean;
  localShellEnabled: boolean;
  wsStatus: WsConnectionStatus;
  checking: boolean;
  error: string | null;
}

function readWindowBootstrap(): Partial<WebRuntimeConfig> | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig }).__LIGHTERM_WEB__;
  return raw && typeof raw === 'object' ? raw : null;
}

function createInitialAuthState(): WebAuthState {
  const boot = readWindowBootstrap();
  return {
    authRequired: Boolean(boot?.authRequired),
    usernameRequired: Boolean(boot?.usernameRequired),
    authenticated: boot ? Boolean(boot.authenticated) : true,
    localShellEnabled: Boolean(boot?.localShellEnabled),
    wsStatus: 'disconnected',
    checking: false,
    error: null,
  };
}

export const useWebAuthStore = create<WebAuthState>(() => createInitialAuthState());

export function resolveApiUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, '');
  if (typeof window === 'undefined' || !window.location?.href) {
    return `/${clean}`;
  }
  try {
    return new URL(clean, window.location.href).toString();
  } catch {
    return `/${clean}`;
  }
}

export function resolveWsUrl(): string {
  const httpUrl = resolveApiUrl('ws');
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }
  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://127.0.0.1:8080/ws';
}

type EventHandler = (payload: unknown) => void;

const wsSubscribers = new Map<string, Set<EventHandler>>();
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let shouldReconnect = false;

function clearTimers(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeWebSocket(): void {
  shouldReconnect = false;
  clearTimers();
  if (ws) {
    const current = ws;
    ws = null;
    try {
      current.close(1000, 'Client disconnect');
    } catch {
      // Ignore close errors
    }
  }
  useWebAuthStore.setState({ wsStatus: 'disconnected' });
}

function scheduleReconnect(): void {
  if (!shouldReconnect || wsSubscribers.size === 0) return;
  const auth = useWebAuthStore.getState();
  if (auth.authRequired && !auth.authenticated) return;
  if (reconnectTimer !== null) return;

  const delay = Math.min(5000, 500 * 2 ** Math.min(reconnectAttempt, 4));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureWebSocket();
  }, delay);
}

export function ensureWebSocket(): void {
  if (typeof WebSocket === 'undefined') return;
  const auth = useWebAuthStore.getState();
  if (auth.authRequired && !auth.authenticated) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  shouldReconnect = true;
  clearTimers();
  useWebAuthStore.setState({ wsStatus: 'connecting' });

  let socket: WebSocket;
  try {
    socket = new WebSocket(resolveWsUrl());
  } catch {
    useWebAuthStore.setState({ wsStatus: 'disconnected' });
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    reconnectAttempt = 0;
    useWebAuthStore.setState({ wsStatus: 'connected' });
    heartbeatTimer = setInterval(() => {
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore send errors
        }
      }
    }, 25_000);
  };

  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { event?: string; payload?: unknown };
      if (!msg.event || msg.event === 'pong') return;
      const handlers = wsSubscribers.get(msg.event);
      if (handlers) {
        handlers.forEach((cb) => {
          try {
            cb(msg.payload);
          } catch {
            // Isolate subscriber errors
          }
        });
      }
    } catch {
      // Ignore malformed WS messages
    }
  };

  socket.onclose = (ev) => {
    if (ws === socket) {
      ws = null;
    }
    clearTimers();
    useWebAuthStore.setState({ wsStatus: 'disconnected' });
    if (ev.code === 4401) {
      shouldReconnect = false;
      useWebAuthStore.setState({ authenticated: false });
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    // onclose handles state transition and reconnect backoff
  };
}

function handleWebAuthExpired(): void {
  if (typeof window !== 'undefined') {
    const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
    if (w.__LIGHTERM_WEB__) {
      w.__LIGHTERM_WEB__ = { ...w.__LIGHTERM_WEB__, authenticated: false };
    }
  }
  useWebAuthStore.setState({ authRequired: true, authenticated: false });
  closeWebSocket();
}

async function parseErrorResponse(res: Response): Promise<{ code?: string; message: string }> {
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      return {
        code: parsed.code,
        message: parsed.message || text,
      };
    } catch {
      return { message: text };
    }
  }
  return { message: `HTTP ${res.status} ${res.statusText}`.trim() };
}

export const webAuth = {
  syncFromWindowConfig(): void {
    const boot = readWindowBootstrap();
    if (!boot) return;
    useWebAuthStore.setState({
      authRequired: Boolean(boot.authRequired),
      usernameRequired: Boolean(boot.usernameRequired),
      authenticated: Boolean(boot.authenticated),
      localShellEnabled: Boolean(boot.localShellEnabled),
    });
  },

  async checkStatus(): Promise<WebAuthState> {
    useWebAuthStore.setState({ checking: true, error: null });
    try {
      const res = await fetch(resolveApiUrl('api/auth/status'), {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        throw new Error((await parseErrorResponse(res)).message);
      }
      const data = (await res.json()) as {
        authRequired: boolean;
        usernameRequired: boolean;
        authenticated: boolean;
        localShellEnabled?: boolean;
      };
      useWebAuthStore.setState((prev) => ({
        authRequired: Boolean(data.authRequired),
        usernameRequired: Boolean(data.usernameRequired),
        authenticated: Boolean(data.authenticated),
        localShellEnabled:
          data.localShellEnabled !== undefined
            ? Boolean(data.localShellEnabled)
            : prev.localShellEnabled,
        checking: false,
      }));
      if (typeof window !== 'undefined') {
        const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
        if (w.__LIGHTERM_WEB__) {
          w.__LIGHTERM_WEB__ = {
            ...w.__LIGHTERM_WEB__,
            authRequired: Boolean(data.authRequired),
            usernameRequired: Boolean(data.usernameRequired),
            authenticated: Boolean(data.authenticated),
            localShellEnabled:
              data.localShellEnabled !== undefined
                ? Boolean(data.localShellEnabled)
                : w.__LIGHTERM_WEB__.localShellEnabled,
          };
        }
      }
      return useWebAuthStore.getState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useWebAuthStore.setState({ checking: false, error: message });
      throw err;
    }
  },

  async login(password: string, username?: string): Promise<void> {
    useWebAuthStore.setState({ checking: true, error: null });
    try {
      const res = await fetch(resolveApiUrl('api/auth/login'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username?.trim() ? username.trim() : undefined,
          password,
        }),
      });
      if (!res.ok) {
        const err = await parseErrorResponse(res);
        useWebAuthStore.setState({ checking: false, error: err.message });
        throw new Error(err.message);
      }
      const data = (await res.json()) as {
        authRequired: boolean;
        usernameRequired: boolean;
        authenticated: boolean;
        localShellEnabled?: boolean;
      };
      if (typeof window !== 'undefined') {
        const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
        if (w.__LIGHTERM_WEB__) {
          w.__LIGHTERM_WEB__ = {
            ...w.__LIGHTERM_WEB__,
            authenticated: Boolean(data.authenticated),
            localShellEnabled:
              data.localShellEnabled !== undefined
                ? Boolean(data.localShellEnabled)
                : w.__LIGHTERM_WEB__.localShellEnabled,
          };
        }
      }
      useWebAuthStore.setState((prev) => ({
        authRequired: Boolean(data.authRequired),
        usernameRequired: Boolean(data.usernameRequired),
        authenticated: Boolean(data.authenticated),
        localShellEnabled:
          data.localShellEnabled !== undefined
            ? Boolean(data.localShellEnabled)
            : prev.localShellEnabled,
        checking: false,
        error: null,
      }));
      if (data.authenticated && wsSubscribers.size > 0) {
        ensureWebSocket();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useWebAuthStore.setState({ checking: false, error: message });
      throw err;
    }
  },

  async logout(): Promise<void> {
    closeWebSocket();
    try {
      await fetch(resolveApiUrl('api/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Ignore network errors during logout
    }
    const authRequired = useWebAuthStore.getState().authRequired;
    if (typeof window !== 'undefined') {
      const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
      if (w.__LIGHTERM_WEB__) {
        w.__LIGHTERM_WEB__ = {
          ...w.__LIGHTERM_WEB__,
          authenticated: !authRequired,
        };
      }
    }
    useWebAuthStore.setState({
      authenticated: !authRequired,
      wsStatus: 'disconnected',
      error: null,
    });
  },
};

export async function invokeWebRpc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (cmd === 'terminal_write' && args) {
      ws.send(
        JSON.stringify({
          type: 'terminal:write',
          sessionId: args.sessionId,
          dataBase64: args.dataBase64,
        }),
      );
      return undefined as T;
    }
    if (cmd === 'terminal_resize' && args) {
      ws.send(
        JSON.stringify({
          type: 'terminal:resize',
          sessionId: args.sessionId,
          cols: args.cols,
          rows: args.rows,
        }),
      );
      return undefined as T;
    }
  }

  const res = await fetch(resolveApiUrl(`api/rpc/${encodeURIComponent(cmd)}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });

  if (res.status === 401) {
    const parsed = await parseErrorResponse(res);
    if (parsed.code === 'WEB_AUTH_REQUIRED') {
      handleWebAuthExpired();
    }
    throw new Error(parsed.message);
  }

  if (!res.ok) {
    const parsed = await parseErrorResponse(res);
    const error = new Error(parsed.message) as Error & { code?: string };
    error.code = parsed.code;
    throw error;
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text.trim()) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export async function listenWebEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  let set = wsSubscribers.get(event);
  if (!set) {
    set = new Set();
    wsSubscribers.set(event, set);
  }
  const wrapped: EventHandler = (payload) => handler(payload as T);
  set.add(wrapped);

  ensureWebSocket();

  return () => {
    const existing = wsSubscribers.get(event);
    if (!existing) return;
    existing.delete(wrapped);
    if (existing.size === 0) {
      wsSubscribers.delete(event);
    }
  };
}

export async function webSftpUpload(
  hostId: string,
  remotePath: string,
  file: File,
): Promise<void> {
  const qs = new URLSearchParams({
    hostId,
    remotePath,
    fileName: file.name,
  });
  const res = await fetch(resolveApiUrl(`api/sftp/upload?${qs.toString()}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-File-Size': String(file.size),
    },
    body: file,
  });

  if (res.status === 401) {
    const parsed = await parseErrorResponse(res);
    if (parsed.code === 'WEB_AUTH_REQUIRED') {
      handleWebAuthExpired();
    }
    throw new Error(parsed.message);
  }

  if (!res.ok) {
    const parsed = await parseErrorResponse(res);
    throw new Error(parsed.message);
  }
}

const DIRECT_DOWNLOAD_THRESHOLD_BYTES = 256 * 1024 * 1024;

export async function webSftpDownload(
  hostId: string,
  remotePath: string,
  fileName: string,
  fileSize?: number,
): Promise<void> {
  const qs = new URLSearchParams({
    hostId,
    remotePath,
  });
  const url = resolveApiUrl(`api/sftp/download?${qs.toString()}`);

  if (fileSize !== undefined && fileSize > DIRECT_DOWNLOAD_THRESHOLD_BYTES) {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }

  const res = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin',
  });

  if (res.status === 401) {
    const parsed = await parseErrorResponse(res);
    if (parsed.code === 'WEB_AUTH_REQUIRED') {
      handleWebAuthExpired();
    }
    throw new Error(parsed.message);
  }

  if (!res.ok) {
    const parsed = await parseErrorResponse(res);
    throw new Error(parsed.message);
  }

  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

export const webSettings = {
  async load(): Promise<WebAppSettings> {
    const data = await invokeWebRpc<WebAppSettings>('web_settings_get');
    const allowLocalShell = Boolean(data?.allowLocalShell);
    useWebAuthStore.setState({ localShellEnabled: allowLocalShell });
    if (typeof window !== 'undefined') {
      const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
      if (w.__LIGHTERM_WEB__) {
        w.__LIGHTERM_WEB__ = {
          ...w.__LIGHTERM_WEB__,
          localShellEnabled: allowLocalShell,
        };
      }
    }
    return { allowLocalShell };
  },

  async save(settings: WebAppSettings): Promise<WebAppSettings> {
    const saved = await invokeWebRpc<WebAppSettings>('web_settings_save', { settings });
    const allowLocalShell = Boolean(saved?.allowLocalShell);
    useWebAuthStore.setState({ localShellEnabled: allowLocalShell });
    if (typeof window !== 'undefined') {
      const w = window as Window & { __LIGHTERM_WEB__?: WebRuntimeConfig };
      if (w.__LIGHTERM_WEB__) {
        w.__LIGHTERM_WEB__ = {
          ...w.__LIGHTERM_WEB__,
          localShellEnabled: allowLocalShell,
        };
      }
    }
    return { allowLocalShell };
  },
};

export function resetWebTransportForTesting(): void {
  closeWebSocket();
  wsSubscribers.clear();
  reconnectAttempt = 0;
  useWebAuthStore.setState(createInitialAuthState());
}
