import { create } from 'zustand';
import type {
  AppSettings,
  ConnectionTestResult,
  HostConfig,
  LocalShellProfile,
  RecentHostEntry,
  SavedWorkspace,
  SessionInfo,
  SessionKind,
  SessionStatus,
} from '../types';
import { base64ToBytes, utf8ToBase64 } from '../utils/base64';
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts';
import { hasBackendRuntime, invokeBackend, listenBackend, makeUuid, readLs, writeLs } from './ipc';

const LS_HOSTS = 'lighterm:hosts';
const LS_RECENT_HOSTS = 'lighterm:recent-hosts';
const LS_WORKSPACES = 'lighterm:workspaces';
const LS_SETTINGS = 'lighterm:settings';
const MAX_RECENT_HOSTS = 20;
const MAX_HISTORY_BYTES = 256 * 1024;
const MAX_EARLY_CHUNKS = 256;

export function getFallbackLocalShells(): LocalShellProfile[] {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const ua = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`.toLowerCase();
  const isWindows = ua.includes('win') || (!ua.includes('mac') && !ua.includes('linux'));
  const isMac = ua.includes('mac');

  if (isWindows) {
    return [
      {
        id: 'pwsh',
        name: 'PowerShell 7',
        shell: 'pwsh.exe',
        description: 'Cross-platform PowerShell',
        isDefault: true,
      },
      {
        id: 'powershell',
        name: 'Windows PowerShell',
        shell: 'powershell.exe',
        description: 'Built-in Windows PowerShell',
        isDefault: false,
      },
      {
        id: 'cmd',
        name: 'Command Prompt',
        shell: 'cmd.exe',
        description: 'Windows Command Processor',
        isDefault: false,
      },
      {
        id: 'git-bash',
        name: 'Git Bash',
        shell: 'bash.exe',
        description: 'Git for Windows Bash',
        isDefault: false,
      },
      {
        id: 'wsl',
        name: 'WSL',
        shell: 'wsl.exe',
        description: 'Windows Subsystem for Linux',
        isDefault: false,
      },
    ];
  }

  if (isMac) {
    return [
      {
        id: 'zsh',
        name: 'Zsh',
        shell: '/bin/zsh',
        description: 'Z Shell',
        isDefault: true,
      },
      {
        id: 'bash',
        name: 'Bash',
        shell: '/bin/bash',
        description: 'Bourne Again Shell',
        isDefault: false,
      },
      {
        id: 'sh',
        name: 'POSIX Shell',
        shell: '/bin/sh',
        description: 'Standard system shell',
        isDefault: false,
      },
    ];
  }

  return [
    {
      id: 'bash',
      name: 'Bash',
      shell: '/bin/bash',
      description: 'Bourne Again Shell',
      isDefault: true,
    },
    {
      id: 'zsh',
      name: 'Zsh',
      shell: '/bin/zsh',
      description: 'Z Shell',
      isDefault: false,
    },
    {
      id: 'sh',
      name: 'POSIX Shell',
      shell: '/bin/sh',
      description: 'Standard system shell',
      isDefault: false,
    },
  ];
}

export function formatRelativeTime(ts: number): string {
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function resolveRecentHostEntry(
  entry: RecentHostEntry,
  hosts: HostConfig[],
): { entry: RecentHostEntry; savedHost?: HostConfig } {
  const savedHost = entry.hostId ? hosts.find((h) => h.id === entry.hostId) : undefined;
  if (!savedHost) {
    return { entry };
  }
  return {
    savedHost,
    entry: {
      ...entry,
      name: savedHost.name || `${savedHost.username}@${savedHost.host}`,
      group: savedHost.group || null,
      host: savedHost.host,
      port: savedHost.port,
      username: savedHost.username,
      color: savedHost.color ?? null,
    },
  };
}

export function getEffectiveLocalShells(localShells: LocalShellProfile[]): LocalShellProfile[] {
  if (hasBackendRuntime()) {
    return localShells;
  }
  return localShells.length > 0 ? localShells : getFallbackLocalShells();
}

export function resolveEffectiveDefaultLocalShell(
  settings: AppSettings,
  localShells: LocalShellProfile[],
): {
  shell?: string;
  profile?: LocalShellProfile;
  isConfigured: boolean;
  isAvailableOnSystem: boolean;
} {
  const effectiveShells = getEffectiveLocalShells(localShells);
  const autoProfile = effectiveShells.find((p) => p.isDefault) ?? effectiveShells[0];
  const configured = settings.defaultLocalShell?.trim();
  if (configured) {
    const norm = configured.toLowerCase();
    const matched = effectiveShells.find(
      (p) => p.shell.trim().toLowerCase() === norm || p.id.toLowerCase() === norm,
    );
    if (matched) {
      return {
        shell: matched.shell,
        profile: matched,
        isConfigured: true,
        isAvailableOnSystem: true,
      };
    }
    return {
      shell: autoProfile?.shell,
      profile: autoProfile,
      isConfigured: true,
      isAvailableOnSystem: false,
    };
  }
  return {
    shell: autoProfile?.shell,
    profile: autoProfile,
    isConfigured: false,
    isAvailableOnSystem: Boolean(autoProfile),
  };
}

export function orderLocalShellsByDefault(
  shells: LocalShellProfile[],
  effectiveDefault: { shell?: string; profile?: LocalShellProfile },
): { profile: LocalShellProfile; isDefault: boolean }[] {
  const mapped = shells.map((profile) => {
    const isDefault =
      effectiveDefault.profile?.id === profile.id ||
      effectiveDefault.shell?.toLowerCase() === profile.shell.toLowerCase();
    return { profile, isDefault };
  });
  return mapped.sort((a, b) => {
    if (a.isDefault === b.isDefault) return 0;
    return a.isDefault ? -1 : 1;
  });
}

function normalizeRecentHosts(entries: RecentHostEntry[]): RecentHostEntry[] {
  const sorted = [...entries].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  const seen = new Set<string>();
  const out: RecentHostEntry[] = [];
  for (const entry of sorted) {
    if (!entry.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(entry);
    if (out.length >= MAX_RECENT_HOSTS) break;
  }
  return out;
}

export interface ShellSessionRecord {
  info: SessionInfo;
  hostId?: string;
  hostConfig?: HostConfig;
  cwd?: string;
  shell?: string;
}

export interface ShellStoreState {
  initialized: boolean;
  sessions: Record<string, ShellSessionRecord>;
  sessionOrder: string[];
  activeSessionId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  sessionMessages: Record<string, string | undefined>;
  sessionDimensions: Record<string, { cols: number; rows: number }>;
  hosts: HostConfig[];
  recentHosts: RecentHostEntry[];
  localShells: LocalShellProfile[];
  localShellsLoaded: boolean;
  savedWorkspaces: SavedWorkspace[];
  settings: AppSettings;

  hostModalOpen: boolean;
  editingHost: HostConfig | null;
  settingsModalOpen: boolean;
  settingsActiveTab: string;
  commandPaletteOpen: boolean;
  hostPaletteOpen: boolean;
  pluginManagerOpen: boolean;
  statusBannerError: string | null;
}

export function createDefaultSettings(): AppSettings {
  return {
    themeId: 'tokyo-night',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', monospace",
    fontSize: 14,
    lineHeight: 1.35,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 10000,
    backgroundOpacity: 0.96,
    copyOnSelect: false,
    defaultLocalShell: null,
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
}

export function parseQuickSshInput(raw: string): {
  username: string;
  host: string;
  port: number;
} | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith('ssh ')) {
    text = text.slice(4).trim();
  }

  let port = 22;
  const portFlagMatch = text.match(/(?:^|\s)-p\s+(\d+)(?:\s|$)/);
  if (portFlagMatch) {
    port = Number(portFlagMatch[1]) || 22;
    text = text.replace(portFlagMatch[0], ' ').trim();
  }

  const target = text.split(/\s+/)[0] ?? '';
  if (!target.includes('@')) {
    return null;
  }

  const [username, hostPart] = target.split('@', 2);
  if (!username || !hostPart) return null;

  const colonIdx = hostPart.lastIndexOf(':');
  if (colonIdx > 0 && /^\d+$/.test(hostPart.slice(colonIdx + 1))) {
    const parsedPort = Number(hostPart.slice(colonIdx + 1));
    return {
      username,
      host: hostPart.slice(0, colonIdx),
      port: parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 22,
    };
  }

  return { username, host: hostPart, port };
}

export const useShellStore = create<ShellStoreState>(() => ({
  initialized: false,
  sessions: {},
  sessionOrder: [],
  activeSessionId: null,
  sessionStatuses: {},
  sessionMessages: {},
  sessionDimensions: {},
  hosts: [],
  recentHosts: [],
  localShells: [],
  localShellsLoaded: false,
  savedWorkspaces: [],
  settings: createDefaultSettings(),

  hostModalOpen: false,
  editingHost: null,
  settingsModalOpen: false,
  settingsActiveTab: 'appearance',
  commandPaletteOpen: false,
  hostPaletteOpen: false,
  pluginManagerOpen: false,
  statusBannerError: null,
}));

type OutputSubscriber = (dataBase64: string) => void;
type SessionCreatedListener = (
  session: ShellSessionRecord,
  meta?: Record<string, unknown>,
) => void;
type SessionClosedListener = (sessionId: string) => void;
type SessionInputListener = (sessionId: string, text: string) => void;
type SessionOutputListener = (sessionId: string, bytes: Uint8Array) => void;
type ActiveSessionListener = (sessionId: string | null) => void;
type ConfigReloadedListener = () => void;
type ConfigMutatedListener = (scope: string) => void;

interface MockSession {
  info: SessionInfo;
  lineBuffer: string;
  cwd: string;
  prompt: string;
}

const mockSessions = new Map<string, MockSession>();
const outputSubscribers = new Map<string, Set<OutputSubscriber>>();
const earlyOutputBuffer = new Map<string, string[]>();
const everMountedSessions = new Set<string>();
const historyChunks = new Map<string, { chunks: string[]; totalBytes: number }>();

const sessionCreatedListeners = new Set<SessionCreatedListener>();
const sessionClosedListeners = new Set<SessionClosedListener>();
const sessionInputListeners = new Set<SessionInputListener>();
const sessionOutputListeners = new Set<SessionOutputListener>();
const activeSessionListeners = new Set<ActiveSessionListener>();
const configReloadedListeners = new Set<ConfigReloadedListener>();
const configMutatedListeners = new Set<ConfigMutatedListener>();

let tauriListenersPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function appendHistoryChunk(sessionId: string, dataBase64: string, byteLen: number): void {
  let entry = historyChunks.get(sessionId);
  if (!entry) {
    entry = { chunks: [], totalBytes: 0 };
    historyChunks.set(sessionId, entry);
  }
  entry.chunks.push(dataBase64);
  entry.totalBytes += byteLen;

  while (entry.totalBytes > MAX_HISTORY_BYTES && entry.chunks.length > 1) {
    const removed = entry.chunks.shift();
    if (removed) {
      try {
        entry.totalBytes -= base64ToBytes(removed).length;
      } catch {
        entry.totalBytes = Math.max(0, entry.totalBytes - removed.length);
      }
    }
  }
}

function dispatchOutput(sessionId: string, dataBase64: string): void {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(dataBase64);
  } catch {
    bytes = new Uint8Array(0);
  }

  appendHistoryChunk(sessionId, dataBase64, bytes.length);

  sessionOutputListeners.forEach((cb) => cb(sessionId, bytes));

  const subs = outputSubscribers.get(sessionId);
  if (subs && subs.size > 0) {
    subs.forEach((cb) => cb(dataBase64));
    return;
  }

  if (!everMountedSessions.has(sessionId)) {
    const existing = earlyOutputBuffer.get(sessionId) ?? [];
    existing.push(dataBase64);
    if (existing.length > MAX_EARLY_CHUNKS) {
      existing.splice(0, existing.length - MAX_EARLY_CHUNKS);
    }
    earlyOutputBuffer.set(sessionId, existing);
  }
}

function dispatchStatus(sessionId: string, status: SessionStatus, message?: string): void {
  useShellStore.setState((state) => ({
    sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
    sessionMessages: { ...state.sessionMessages, [sessionId]: message },
  }));
}

function dispatchExit(sessionId: string): void {
  useShellStore.setState((state) => ({
    sessionStatuses: { ...state.sessionStatuses, [sessionId]: 'disconnected' },
  }));
}

async function ensureTauriListeners(): Promise<void> {
  if (!hasBackendRuntime()) return;
  if (tauriListenersPromise) return tauriListenersPromise;

  tauriListenersPromise = (async () => {
    await Promise.all([
      listenBackend<{ sessionId: string; dataBase64: string }>('terminal:output', (payload) => {
        dispatchOutput(payload.sessionId, payload.dataBase64);
      }),
      listenBackend<{ sessionId: string; status: SessionStatus; message?: string }>(
        'terminal:status',
        (payload) => {
          dispatchStatus(payload.sessionId, payload.status, payload.message);
        },
      ),
      listenBackend<{ sessionId: string; exitCode?: number }>('terminal:exit', (payload) => {
        dispatchExit(payload.sessionId);
      }),
    ]);
  })().catch((err) => {
    tauriListenersPromise = null;
    throw err;
  });

  return tauriListenersPromise;
}

function handleMockCommand(session: MockSession, rawCmd: string): void {
  const cmd = rawCmd.trim();
  const emit = (txt: string) => dispatchOutput(session.info.id, utf8ToBase64(txt));

  if (!cmd) {
    emit(`\r\n${session.prompt}`);
    return;
  }

  let out = '';
  if (cmd === 'help') {
    out =
      'Lighterm Demo Shell Commands: help, pwd, ls, whoami, uname -a, clear\r\n' +
      '(Run inside Tauri desktop app for full native PTY, SSH2, and plugin backend.)';
  } else if (cmd === 'pwd') {
    out = session.cwd;
  } else if (cmd === 'ls' || cmd.startsWith('ls ')) {
    out = 'Cargo.toml  README.md  crates/  package.json  src/  src-tauri/';
  } else if (cmd === 'whoami') {
    out = session.info.kind === 'ssh' ? session.info.title.split('@')[0] || 'deploy' : 'lighterm';
  } else if (cmd.startsWith('uname')) {
    out = 'Linux lighterm 6.12.0 x86_64 GNU/Linux';
  } else if (cmd === 'clear') {
    emit(`\x1b[2J\x1b[H${session.prompt}`);
    return;
  } else if (cmd.startsWith('echo ')) {
    out = cmd.slice(5);
  } else {
    out = `Executed: ${cmd}`;
  }

  emit(`\r\n${out}\r\n${session.prompt}`);
}

export class ShellService {
  async initialize(): Promise<void> {
    if (useShellStore.getState().initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      await ensureTauriListeners();
      const [settings, hosts, recentHosts, localShells, savedWorkspaces] = await Promise.all([
        this.loadSettings().catch(() => createDefaultSettings()),
        this.listHosts().catch(() => [] as HostConfig[]),
        this.listRecentHosts().catch(() => [] as RecentHostEntry[]),
        this.listLocalShells().catch(() => getFallbackLocalShells()),
        this.listSavedWorkspaces().catch(() => [] as SavedWorkspace[]),
      ]);
      const defaults = createDefaultSettings();
      useShellStore.setState({
        settings: {
          ...defaults,
          ...settings,
          shortcuts: { ...defaults.shortcuts, ...settings.shortcuts },
        },
        hosts,
        recentHosts,
        localShells,
        savedWorkspaces,
        initialized: true,
      });
    })().catch((err) => {
      initPromise = null;
      throw err;
    });

    return initPromise;
  }

  async createLocalSession(params?: {
    cols?: number;
    rows?: number;
    cwd?: string;
    shell?: string;
    title?: string;
    meta?: Record<string, unknown>;
  }): Promise<SessionInfo | null> {
    const cols = params?.cols ?? 100;
    const rows = params?.rows ?? 30;
    const state = useShellStore.getState();
    const count = state.sessionOrder.length + 1;
    const title = params?.title ?? `Terminal ${count}`;
    const effectiveShell = params?.shell?.trim()
      ? params.shell.trim()
      : resolveEffectiveDefaultLocalShell(state.settings, state.localShells).shell;

    try {
      let info: SessionInfo;
      if (hasBackendRuntime()) {
        await ensureTauriListeners();
        info = await invokeBackend<SessionInfo>('terminal_create_local', {
          cols,
          rows,
          cwd: params?.cwd,
          shell: effectiveShell,
          title,
        });
      } else {
        const id = makeUuid();
        info = {
          id,
          kind: 'local',
          title,
          hostId: null,
          cols,
          rows,
          status: 'connected',
          createdAt: Date.now(),
        };
      }

      const record: ShellSessionRecord = {
        info,
        cwd: params?.cwd,
        shell: effectiveShell,
      };
      useShellStore.setState((state) => ({
        sessions: { ...state.sessions, [info.id]: record },
        sessionOrder: [...state.sessionOrder, info.id],
        activeSessionId: info.id,
        sessionStatuses: { ...state.sessionStatuses, [info.id]: info.status },
        sessionDimensions: { ...state.sessionDimensions, [info.id]: { cols, rows } },
        statusBannerError: null,
      }));

      sessionCreatedListeners.forEach((cb) => cb(record, params?.meta));
      activeSessionListeners.forEach((cb) => cb(info.id));

      if (!hasBackendRuntime()) {
        const prompt = '\x1b[36mlighterm\x1b[0m:\x1b[34m~\x1b[0m$ ';
        mockSessions.set(info.id, { info, lineBuffer: '', cwd: '/home/lighterm', prompt });
        dispatchStatus(info.id, 'connected');
        dispatchOutput(
          info.id,
          utf8ToBase64(
            `\x1b[1;34mLighterm Preview Terminal\x1b[0m (Browser mode — type \x1b[33mhelp\x1b[0m)\r\n${prompt}`,
          ),
        );
      }

      return info;
    } catch (err) {
      console.error('[Lighterm] Failed to create local session:', err);
      this.setBannerError(`Failed to open local shell: ${formatErrorMessage(err)}`);
      return null;
    }
  }

  async createSshSession(params: {
    hostId?: string;
    hostConfig?: HostConfig;
    cols?: number;
    rows?: number;
    meta?: Record<string, unknown>;
  }): Promise<SessionInfo | null> {
    const cols = params.cols ?? 100;
    const rows = params.rows ?? 30;
    try {
      let info: SessionInfo;
      let resolvedHost = params.hostConfig;
      if (!resolvedHost && params.hostId) {
        resolvedHost = useShellStore.getState().hosts.find((h) => h.id === params.hostId);
      }

      if (hasBackendRuntime()) {
        await ensureTauriListeners();
        info = await invokeBackend<SessionInfo>('terminal_create_ssh', {
          hostId: params.hostId,
          hostConfig: params.hostConfig,
          cols,
          rows,
        });
      } else {
        const title = resolvedHost
          ? resolvedHost.name || `${resolvedHost.username}@${resolvedHost.host}`
          : 'SSH Session';
        info = {
          id: makeUuid(),
          kind: 'ssh',
          title,
          hostId: resolvedHost?.id ?? params.hostId ?? null,
          cols,
          rows,
          status: 'connected',
          createdAt: Date.now(),
        };
      }

      const record: ShellSessionRecord = {
        info,
        hostId: resolvedHost?.id ?? params.hostId,
        hostConfig: resolvedHost,
      };
      useShellStore.setState((state) => ({
        sessions: { ...state.sessions, [info.id]: record },
        sessionOrder: [...state.sessionOrder, info.id],
        activeSessionId: info.id,
        sessionStatuses: { ...state.sessionStatuses, [info.id]: info.status },
        sessionDimensions: { ...state.sessionDimensions, [info.id]: { cols, rows } },
        statusBannerError: null,
      }));

      sessionCreatedListeners.forEach((cb) => cb(record, params.meta));
      activeSessionListeners.forEach((cb) => cb(info.id));

      if (resolvedHost) {
        const isSaved = useShellStore.getState().hosts.some((h) => h.id === resolvedHost.id);
        void this.recordRecentHost(resolvedHost, isSaved);
      }

      if (!hasBackendRuntime()) {
        const user = resolvedHost?.username ?? 'deploy';
        const hostLabel = resolvedHost?.host ?? 'remote';
        const prompt = `\x1b[32m${user}@${hostLabel}\x1b[0m:\x1b[34m~\x1b[0m$ `;
        mockSessions.set(info.id, { info, lineBuffer: '', cwd: `/home/${user}`, prompt });
        dispatchStatus(info.id, 'connected');
        dispatchOutput(
          info.id,
          utf8ToBase64(
            `\x1b[1;32mConnected to ${user}@${hostLabel}:${resolvedHost?.port ?? 22}\x1b[0m\r\n${prompt}`,
          ),
        );
      }

      return info;
    } catch (err) {
      this.setBannerError(`SSH connection failed: ${formatErrorMessage(err)}`);
      return null;
    }
  }

  async quickConnectSsh(rawInput: string): Promise<SessionInfo | null> {
    const trimmed = rawInput.trim();
    if (!trimmed) return null;

    const matchedHost = useShellStore
      .getState()
      .hosts.find(
        (h) =>
          h.name.toLowerCase() === trimmed.toLowerCase() ||
          h.host.toLowerCase() === trimmed.toLowerCase(),
      );
    if (matchedHost) {
      return this.createSshSession({ hostId: matchedHost.id, hostConfig: matchedHost });
    }

    const parsed = parseQuickSshInput(trimmed);
    if (!parsed) {
      this.setBannerError('Quick SSH format: user@host[:port] or ssh -p 2222 user@host');
      return null;
    }

    const tempHost: HostConfig = {
      id: makeUuid('quick'),
      name: `${parsed.username}@${parsed.host}`,
      group: 'Quick Connect',
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      auth: { type: 'privateKey' },
      updatedAt: Date.now(),
    };
    return this.createSshSession({ hostConfig: tempHost });
  }

  async writeSession(sessionId: string, dataBase64: string): Promise<void> {
    let text = '';
    try {
      text = new TextDecoder().decode(base64ToBytes(dataBase64));
    } catch {
      text = '';
    }
    if (text) {
      sessionInputListeners.forEach((cb) => cb(sessionId, text));
    }

    if (hasBackendRuntime()) {
      return invokeBackend<void>('terminal_write', { sessionId, dataBase64 });
    }

    const session = mockSessions.get(sessionId);
    if (!session) return;

    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        const line = session.lineBuffer;
        session.lineBuffer = '';
        handleMockCommand(session, line);
      } else if (ch === '\x7f' || ch === '\b') {
        if (session.lineBuffer.length > 0) {
          session.lineBuffer = session.lineBuffer.slice(0, -1);
          dispatchOutput(sessionId, utf8ToBase64('\b \b'));
        }
      } else if (ch === '\x03') {
        session.lineBuffer = '';
        dispatchOutput(sessionId, utf8ToBase64(`^C\r\n${session.prompt}`));
      } else if (ch.charCodeAt(0) >= 0x20) {
        session.lineBuffer += ch;
        dispatchOutput(sessionId, utf8ToBase64(ch));
      }
    }
  }

  async sendTextToActiveSession(text: string, appendNewline = false): Promise<void> {
    const activeId = useShellStore.getState().activeSessionId;
    if (!activeId) return;
    const payload = appendNewline ? `${text}\n` : text;
    await this.writeSession(activeId, utf8ToBase64(payload));
  }

  async resizeSession(sessionId: string, cols: number, rows: number): Promise<void> {
    useShellStore.setState((state) => ({
      sessionDimensions: { ...state.sessionDimensions, [sessionId]: { cols, rows } },
    }));

    if (hasBackendRuntime()) {
      return invokeBackend<void>('terminal_resize', { sessionId, cols, rows });
    }
    const s = mockSessions.get(sessionId);
    if (s) {
      s.info.cols = cols;
      s.info.rows = rows;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    earlyOutputBuffer.delete(sessionId);
    historyChunks.delete(sessionId);
    everMountedSessions.delete(sessionId);

    if (hasBackendRuntime()) {
      await invokeBackend<void>('terminal_close', { sessionId }).catch(() => {});
    } else {
      mockSessions.delete(sessionId);
    }

    let nextActiveId: string | null = null;
    useShellStore.setState((state) => {
      const { [sessionId]: _removed, ...restSessions } = state.sessions;
      const nextOrder = state.sessionOrder.filter((id) => id !== sessionId);
      nextActiveId =
        state.activeSessionId === sessionId
          ? nextOrder[nextOrder.length - 1] ?? null
          : state.activeSessionId;
      return {
        sessions: restSessions,
        sessionOrder: nextOrder,
        activeSessionId: nextActiveId,
      };
    });

    sessionClosedListeners.forEach((cb) => cb(sessionId));
    activeSessionListeners.forEach((cb) => cb(nextActiveId));
  }

  setActiveSession(sessionId: string | null): void {
    const state = useShellStore.getState();
    if (state.activeSessionId === sessionId) return;
    if (sessionId && !state.sessions[sessionId]) return;
    useShellStore.setState({ activeSessionId: sessionId });
    activeSessionListeners.forEach((cb) => cb(sessionId));
  }

  getActiveSession(): ShellSessionRecord | null {
    const state = useShellStore.getState();
    if (!state.activeSessionId) return null;
    return state.sessions[state.activeSessionId] ?? null;
  }

  getSession(sessionId: string): ShellSessionRecord | null {
    return useShellStore.getState().sessions[sessionId] ?? null;
  }

  listSessions(): ShellSessionRecord[] {
    const state = useShellStore.getState();
    return state.sessionOrder
      .map((id) => state.sessions[id])
      .filter((s): s is ShellSessionRecord => Boolean(s));
  }

  /**
   * Returns buffered output bytes for remounted viewports, with ConPTY `\x1b[6n` queries stripped
   * so reparenting a terminal does not trigger duplicate CPR responses.
   */
  getReplayBytes(sessionId: string): Uint8Array[] {
    const entry = historyChunks.get(sessionId);
    if (!entry || entry.chunks.length === 0) return [];
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const encoder = new TextEncoder();
    const out: Uint8Array[] = [];
    for (const b64 of entry.chunks) {
      try {
        const bytes = base64ToBytes(b64);
        const text = decoder.decode(bytes);
        if (text.includes('\x1b[6n')) {
          const cleaned = text.replace(/\x1b\[6n/g, '');
          if (cleaned.length > 0) out.push(encoder.encode(cleaned));
        } else {
          out.push(bytes);
        }
      } catch {
        // Ignore malformed chunks
      }
    }
    return out;
  }

  subscribeSessionOutput(
    sessionId: string,
    cb: OutputSubscriber,
  ): { unsubscribe: () => void; hadEarlyBuffer: boolean } {
    let subs = outputSubscribers.get(sessionId);
    if (!subs) {
      subs = new Set();
      outputSubscribers.set(sessionId, subs);
    }
    subs.add(cb);

    const firstMount = !everMountedSessions.has(sessionId);
    everMountedSessions.add(sessionId);

    const buffered = earlyOutputBuffer.get(sessionId);
    let hadEarlyBuffer = false;
    if (firstMount && buffered && buffered.length > 0) {
      hadEarlyBuffer = true;
      earlyOutputBuffer.delete(sessionId);
      for (const chunk of buffered) {
        cb(chunk);
      }
    }

    return {
      hadEarlyBuffer,
      unsubscribe: () => {
        const set = outputSubscribers.get(sessionId);
        if (!set) return;
        set.delete(cb);
        if (set.size === 0) {
          outputSubscribers.delete(sessionId);
        }
      },
    };
  }

  onSessionCreated(cb: SessionCreatedListener): () => void {
    sessionCreatedListeners.add(cb);
    return () => sessionCreatedListeners.delete(cb);
  }

  onSessionClosed(cb: SessionClosedListener): () => void {
    sessionClosedListeners.add(cb);
    return () => sessionClosedListeners.delete(cb);
  }

  onSessionInput(cb: SessionInputListener): () => void {
    sessionInputListeners.add(cb);
    return () => sessionInputListeners.delete(cb);
  }

  onSessionOutput(cb: SessionOutputListener): () => void {
    sessionOutputListeners.add(cb);
    return () => sessionOutputListeners.delete(cb);
  }

  onActiveSessionChanged(cb: ActiveSessionListener): () => void {
    activeSessionListeners.add(cb);
    return () => activeSessionListeners.delete(cb);
  }

  onConfigReloaded(cb: ConfigReloadedListener): () => void {
    configReloadedListeners.add(cb);
    return () => configReloadedListeners.delete(cb);
  }

  onConfigMutated(cb: ConfigMutatedListener): () => void {
    configMutatedListeners.add(cb);
    return () => configMutatedListeners.delete(cb);
  }

  notifyConfigMutated(scope: string): void {
    configMutatedListeners.forEach((cb) => {
      try {
        cb(scope);
      } catch {
        // Isolate listener errors
      }
    });
  }

  async reloadAll(): Promise<void> {
    const [settings, hosts, recentHosts, localShells, savedWorkspaces] = await Promise.all([
      this.loadSettings().catch(() => createDefaultSettings()),
      this.listHosts().catch(() => [] as HostConfig[]),
      this.listRecentHosts().catch(() => [] as RecentHostEntry[]),
      this.listLocalShells().catch(() => getFallbackLocalShells()),
      this.listSavedWorkspaces().catch(() => [] as SavedWorkspace[]),
    ]);
    const defaults = createDefaultSettings();
    useShellStore.setState({
      settings: {
        ...defaults,
        ...settings,
        shortcuts: { ...defaults.shortcuts, ...settings.shortcuts },
      },
      hosts,
      recentHosts,
      localShells,
      savedWorkspaces,
    });
    configReloadedListeners.forEach((cb) => {
      try {
        cb();
      } catch {
        // Isolate listener errors
      }
    });
  }

  // ---- Core Host Management ----

  async listHosts(): Promise<HostConfig[]> {
    const hosts = hasBackendRuntime()
      ? await invokeBackend<HostConfig[]>('hosts_list')
      : readLs<HostConfig[]>(LS_HOSTS, () => []);
    useShellStore.setState({ hosts });
    return hosts;
  }

  async saveHost(host: HostConfig): Promise<HostConfig> {
    let saved: HostConfig;
    if (hasBackendRuntime()) {
      saved = await invokeBackend<HostConfig>('hosts_save', { host });
    } else {
      const hosts = readLs<HostConfig[]>(LS_HOSTS, () => []);
      saved = {
        ...host,
        id: host.id.trim() ? host.id : makeUuid(),
        updatedAt: Date.now(),
      };
      const idx = hosts.findIndex((h) => h.id === saved.id);
      if (idx >= 0) hosts[idx] = saved;
      else hosts.push(saved);
      writeLs(LS_HOSTS, hosts);
    }
    const hosts = await this.listHosts();
    useShellStore.setState({ hosts, hostModalOpen: false, editingHost: null });
    this.notifyConfigMutated('hosts');
    return saved;
  }

  async deleteHost(id: string): Promise<void> {
    if (hasBackendRuntime()) {
      await invokeBackend<void>('hosts_delete', { id });
    } else {
      const hosts = readLs<HostConfig[]>(LS_HOSTS, () => []).filter((h) => h.id !== id);
      writeLs(LS_HOSTS, hosts);
    }
    await this.listHosts();
    const currentRecent = useShellStore.getState().recentHosts;
    if (currentRecent.some((entry) => entry.hostId === id)) {
      await this.saveRecentHostsList(currentRecent.filter((entry) => entry.hostId !== id));
    }
    this.notifyConfigMutated('hosts');
  }

  // ---- Local Shells & Recent Hosts ----

  async listLocalShells(): Promise<LocalShellProfile[]> {
    let shells: LocalShellProfile[];
    if (hasBackendRuntime()) {
      try {
        const res = await invokeBackend<LocalShellProfile[] | null>('terminal_list_local_shells');
        shells = Array.isArray(res) ? res : [];
      } catch {
        shells = [];
      }
    } else {
      shells = getFallbackLocalShells();
    }
    useShellStore.setState({ localShells: shells, localShellsLoaded: true });
    return shells;
  }

  async listRecentHosts(): Promise<RecentHostEntry[]> {
    let raw: RecentHostEntry[];
    if (hasBackendRuntime()) {
      try {
        const res = await invokeBackend<RecentHostEntry[] | null>('recent_hosts_list');
        raw = Array.isArray(res) ? res : [];
      } catch {
        raw = [];
      }
    } else {
      const stored = readLs<RecentHostEntry[]>(LS_RECENT_HOSTS, () => []);
      raw = Array.isArray(stored) ? stored : [];
    }
    const normalized = normalizeRecentHosts(raw);
    useShellStore.setState({ recentHosts: normalized });
    return normalized;
  }

  async saveRecentHostsList(entries: RecentHostEntry[]): Promise<RecentHostEntry[]> {
    const normalized = normalizeRecentHosts(entries);
    useShellStore.setState({ recentHosts: normalized });
    if (hasBackendRuntime()) {
      try {
        const res = await invokeBackend<RecentHostEntry[] | null>('recent_hosts_save', {
          entries: normalized,
        });
        if (Array.isArray(res)) {
          const saved = normalizeRecentHosts(res);
          useShellStore.setState({ recentHosts: saved });
          return saved;
        }
      } catch {
        // Keep optimistic state on transient backend errors
      }
    } else {
      writeLs(LS_RECENT_HOSTS, normalized);
    }
    return normalized;
  }

  async recordRecentHost(host: HostConfig, isSaved: boolean): Promise<RecentHostEntry[]> {
    const hostAddr = host.host.trim();
    const username = host.username.trim();
    if (!hostAddr || !username) {
      return useShellStore.getState().recentHosts;
    }
    const port = host.port || 22;
    const key =
      isSaved && host.id.trim()
        ? `host:${host.id}`
        : `quick:${username.toLowerCase()}@${hostAddr.toLowerCase()}:${port}`;

    const existing = useShellStore.getState().recentHosts;
    const prev = existing.find((item) => item.key === key);
    const nextEntry: RecentHostEntry = {
      key,
      hostId: isSaved && host.id.trim() ? host.id : null,
      name: host.name.trim() || `${username}@${hostAddr}`,
      group: host.group?.trim() ? host.group.trim() : null,
      host: hostAddr,
      port,
      username,
      color: host.color ?? null,
      lastConnectedAt: Date.now(),
      connectCount: (prev?.connectCount ?? 0) + 1,
    };

    return this.saveRecentHostsList([nextEntry, ...existing.filter((item) => item.key !== key)]);
  }

  async removeRecentHost(key: string): Promise<RecentHostEntry[]> {
    const next = useShellStore.getState().recentHosts.filter((item) => item.key !== key);
    return this.saveRecentHostsList(next);
  }

  async clearRecentHosts(): Promise<void> {
    await this.saveRecentHostsList([]);
  }

  async connectRecentHost(entry: RecentHostEntry): Promise<SessionInfo | null> {
    const savedHost = entry.hostId
      ? useShellStore.getState().hosts.find((h) => h.id === entry.hostId)
      : undefined;
    if (savedHost) {
      return this.createSshSession({ hostId: savedHost.id, hostConfig: savedHost });
    }
    const tempHost: HostConfig = {
      id: makeUuid('quick'),
      name: entry.name || `${entry.username}@${entry.host}`,
      group: entry.group || 'Quick Connect',
      host: entry.host,
      port: entry.port || 22,
      username: entry.username,
      auth: { type: 'privateKey' },
      color: entry.color ?? null,
      updatedAt: Date.now(),
    };
    return this.createSshSession({ hostConfig: tempHost });
  }

  async testHostConnection(host: HostConfig): Promise<ConnectionTestResult> {
    if (hasBackendRuntime()) {
      return invokeBackend<ConnectionTestResult>('hosts_test_connection', { host });
    }
    return {
      success: Boolean(host.host.trim() && host.username.trim()),
      latencyMs: 18,
      message: host.host.trim()
        ? `Preview check OK for ${host.username}@${host.host}:${host.port}`
        : 'Host address cannot be empty',
    };
  }

  // ---- Core Saved Workspaces ----

  async listSavedWorkspaces(): Promise<SavedWorkspace[]> {
    const savedWorkspaces = hasBackendRuntime()
      ? await invokeBackend<SavedWorkspace[]>('workspaces_list')
      : readLs<SavedWorkspace[]>(LS_WORKSPACES, () => []);
    useShellStore.setState({ savedWorkspaces });
    return savedWorkspaces;
  }

  async saveWorkspaceRecord(workspace: SavedWorkspace): Promise<SavedWorkspace> {
    const trimmedName = workspace.name.trim();
    if (!trimmedName) {
      throw new Error('Workspace name cannot be empty');
    }
    const payload: SavedWorkspace = {
      ...workspace,
      name: trimmedName,
    };

    let saved: SavedWorkspace;
    if (hasBackendRuntime()) {
      saved = await invokeBackend<SavedWorkspace>('workspaces_save', { workspace: payload });
    } else {
      const workspaces = readLs<SavedWorkspace[]>(LS_WORKSPACES, () => []);
      const now = Date.now();
      const id = payload.id.trim() ? payload.id : makeUuid();
      const existingIdx = workspaces.findIndex((w) => w.id === id);
      const createdAt =
        payload.createdAt > 0
          ? payload.createdAt
          : existingIdx >= 0
            ? workspaces[existingIdx].createdAt
            : now;
      saved = {
        ...payload,
        id,
        createdAt,
        updatedAt: now,
      };
      if (existingIdx >= 0) workspaces[existingIdx] = saved;
      else workspaces.push(saved);
      writeLs(LS_WORKSPACES, workspaces);
    }

    await this.listSavedWorkspaces();
    this.notifyConfigMutated('workspaces');
    return saved;
  }

  async deleteSavedWorkspace(id: string): Promise<void> {
    if (hasBackendRuntime()) {
      await invokeBackend<void>('workspaces_delete', { id });
    } else {
      const workspaces = readLs<SavedWorkspace[]>(LS_WORKSPACES, () => []).filter(
        (w) => w.id !== id,
      );
      writeLs(LS_WORKSPACES, workspaces);
    }
    await this.listSavedWorkspaces();
    this.notifyConfigMutated('workspaces');
  }

  // ---- Core Settings ----

  async loadSettings(): Promise<AppSettings> {
    if (hasBackendRuntime()) {
      return invokeBackend<AppSettings>('settings_get');
    }
    return readLs<AppSettings>(LS_SETTINGS, createDefaultSettings);
  }

  async updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = useShellStore.getState().settings;
    const merged: AppSettings = {
      ...current,
      ...partial,
      shortcuts: {
        ...current.shortcuts,
        ...(partial.shortcuts ?? {}),
      },
    };
    const saved = hasBackendRuntime()
      ? await invokeBackend<AppSettings>('settings_save', { settings: merged })
      : (() => {
          writeLs(LS_SETTINGS, merged);
          return merged;
        })();
    useShellStore.setState({ settings: saved });
    this.notifyConfigMutated('settings');
    return saved;
  }

  // ---- Core Modals & Banner ----

  openHostModal(host: HostConfig | null = null): void {
    useShellStore.setState({ hostModalOpen: true, editingHost: host });
  }

  closeHostModal(): void {
    useShellStore.setState({ hostModalOpen: false, editingHost: null });
  }

  setSettingsModalOpen(open: boolean): void {
    useShellStore.setState({ settingsModalOpen: open });
  }

  setSettingsActiveTab(tabKey: string): void {
    useShellStore.setState({ settingsActiveTab: tabKey });
  }

  openSettings(tabKey?: string): void {
    useShellStore.setState((state) => ({
      settingsModalOpen: true,
      settingsActiveTab: tabKey ?? state.settingsActiveTab,
    }));
  }

  setCommandPaletteOpen(open: boolean): void {
    useShellStore.setState((state) => ({
      commandPaletteOpen: open,
      hostPaletteOpen: open ? false : state.hostPaletteOpen,
    }));
  }

  setHostPaletteOpen(open: boolean): void {
    useShellStore.setState((state) => ({
      hostPaletteOpen: open,
      commandPaletteOpen: open ? false : state.commandPaletteOpen,
    }));
  }

  setPluginManagerOpen(open: boolean): void {
    useShellStore.setState({ pluginManagerOpen: open });
  }

  setBannerError(msg: string | null): void {
    useShellStore.setState({ statusBannerError: msg });
  }

  clearBannerError(): void {
    useShellStore.setState({ statusBannerError: null });
  }

  resetForTesting(): void {
    tauriListenersPromise = null;
    initPromise = null;
    mockSessions.clear();
    outputSubscribers.clear();
    earlyOutputBuffer.clear();
    everMountedSessions.clear();
    historyChunks.clear();
    sessionCreatedListeners.clear();
    sessionClosedListeners.clear();
    sessionInputListeners.clear();
    sessionOutputListeners.clear();
    activeSessionListeners.clear();
    configReloadedListeners.clear();
    configMutatedListeners.clear();
    useShellStore.setState({
      initialized: false,
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      sessionStatuses: {},
      sessionMessages: {},
      sessionDimensions: {},
      hosts: [],
      recentHosts: [],
      localShells: [],
      localShellsLoaded: false,
      savedWorkspaces: [],
      settings: createDefaultSettings(),
      hostModalOpen: false,
      editingHost: null,
      settingsModalOpen: false,
      settingsActiveTab: 'appearance',
      commandPaletteOpen: false,
      hostPaletteOpen: false,
      pluginManagerOpen: false,
      statusBannerError: null,
    });
  }
}

export const shellService = new ShellService();

export const formatSessionHostLabel = (session: ShellSessionRecord | null): string => {
  if (!session) return 'Local';
  return session.info.title;
};

export const getSessionKindLabel = (kind: SessionKind): string =>
  kind === 'ssh' ? 'SSH' : 'Local';

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
