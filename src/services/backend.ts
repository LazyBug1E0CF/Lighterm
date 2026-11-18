import type {
  AppSettings,
  ConnectionTestResult,
  HistoryEntry,
  HostConfig,
  SessionInfo,
  SessionKind,
  SessionStatus,
  SftpEntry,
  SftpTransferProgress,
  Snippet,
  SystemStats,
} from '../types';
import { base64ToBytes, utf8ToBase64 } from '../utils/base64';
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

type OutputCallback = (dataBase64: string) => void;
type StatusCallback = (sessionId: string, status: SessionStatus, message?: string) => void;
type ExitCallback = (sessionId: string, exitCode?: number) => void;
type SftpProgressCallback = (progress: SftpTransferProgress) => void;

const MAX_EARLY_BUFFER_CHUNKS = 256;
const outputSubscribers = new Map<string, Set<OutputCallback>>();
const earlyOutputBuffer = new Map<string, string[]>();
const statusSubscribers = new Set<StatusCallback>();
const exitSubscribers = new Set<ExitCallback>();
const sftpProgressSubscribers = new Set<SftpProgressCallback>();

let tauriListenersReady: Promise<void> | null = null;

function dispatchOutput(sessionId: string, dataBase64: string): void {
  const subs = outputSubscribers.get(sessionId);
  if (subs && subs.size > 0) {
    subs.forEach((cb) => cb(dataBase64));
    return;
  }
  const existing = earlyOutputBuffer.get(sessionId) ?? [];
  existing.push(dataBase64);
  if (existing.length > MAX_EARLY_BUFFER_CHUNKS) {
    existing.splice(0, existing.length - MAX_EARLY_BUFFER_CHUNKS);
  }
  earlyOutputBuffer.set(sessionId, existing);
}

function dispatchStatus(sessionId: string, status: SessionStatus, message?: string): void {
  statusSubscribers.forEach((cb) => cb(sessionId, status, message));
}

function dispatchExit(sessionId: string, exitCode?: number): void {
  exitSubscribers.forEach((cb) => cb(sessionId, exitCode));
}

function dispatchSftpProgress(progress: SftpTransferProgress): void {
  sftpProgressSubscribers.forEach((cb) => cb(progress));
}

async function ensureTauriListeners(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (tauriListenersReady) return tauriListenersReady;

  tauriListenersReady = (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    await Promise.all([
      listen<{ sessionId: string; dataBase64: string }>('terminal:output', (ev) => {
        dispatchOutput(ev.payload.sessionId, ev.payload.dataBase64);
      }),
      listen<{ sessionId: string; status: SessionStatus; message?: string }>(
        'terminal:status',
        (ev) => {
          dispatchStatus(ev.payload.sessionId, ev.payload.status, ev.payload.message);
        },
      ),
      listen<{ sessionId: string; exitCode?: number }>('terminal:exit', (ev) => {
        dispatchExit(ev.payload.sessionId, ev.payload.exitCode);
      }),
      listen<SftpTransferProgress>('sftp:progress', (ev) => {
        dispatchSftpProgress(ev.payload);
      }),
    ]);
  })();

  return tauriListenersReady;
}

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  await ensureTauriListeners();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function subscribeTerminalOutput(sessionId: string, cb: OutputCallback): () => void {
  let subs = outputSubscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    outputSubscribers.set(sessionId, subs);
  }
  subs.add(cb);

  const buffered = earlyOutputBuffer.get(sessionId);
  if (buffered && buffered.length > 0) {
    earlyOutputBuffer.delete(sessionId);
    for (const chunk of buffered) {
      cb(chunk);
    }
  }

  return () => {
    const set = outputSubscribers.get(sessionId);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      outputSubscribers.delete(sessionId);
    }
  };
}

export function subscribeTerminalStatus(cb: StatusCallback): () => void {
  statusSubscribers.add(cb);
  return () => statusSubscribers.delete(cb);
}

export function subscribeTerminalExit(cb: ExitCallback): () => void {
  exitSubscribers.add(cb);
  return () => exitSubscribers.delete(cb);
}

export function subscribeSftpProgress(cb: SftpProgressCallback): () => void {
  sftpProgressSubscribers.add(cb);
  return () => sftpProgressSubscribers.delete(cb);
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

// ---- Mock Fallback Store for Browser / Vitest ----

const LS_HOSTS = 'lighterm:hosts';
const LS_SNIPPETS = 'lighterm:snippets';
const LS_HISTORY = 'lighterm:history';
const LS_SETTINGS = 'lighterm:settings';

function createDefaultSettings(): AppSettings {
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
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
}

function createStarterSnippets(): Snippet[] {
  const now = Date.now();
  return [
    {
      id: 'snip-df',
      title: 'Disk Usage (Human)',
      command: 'df -h',
      category: 'System',
      description: 'Show mounted filesystem disk usage',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-ss',
      title: 'Listening Ports',
      command: 'ss -tulpn',
      category: 'Network',
      description: 'List listening TCP/UDP sockets',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-docker',
      title: 'Docker Containers',
      command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
      category: 'Docker',
      description: 'Compact running container status table',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-logs',
      title: 'Follow Service Logs',
      command: 'journalctl -u {{service}} -f -n 100',
      category: 'System',
      description: 'Tail systemd logs for a service',
      autoExecute: false,
      updatedAt: now,
    },
  ];
}

function readLs<T>(key: string, fallback: () => T): T {
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

function writeLs<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore quota errors in headless environments
  }
}

interface MockSession {
  info: SessionInfo;
  lineBuffer: string;
  cwd: string;
  prompt: string;
}

const mockSessions = new Map<string, MockSession>();

interface MockFsNode {
  name: string;
  isDir: boolean;
  size: number;
  mode: number;
  permissions: string;
  modifiedAt: number;
}

const mockSftpTrees = new Map<string, Map<string, MockFsNode[]>>();

function getMockSftpTree(hostId: string): Map<string, MockFsNode[]> {
  let tree = mockSftpTrees.get(hostId);
  if (!tree) {
    const now = Math.floor(Date.now() / 1000);
    tree = new Map<string, MockFsNode[]>([
      [
        '/home/deploy',
        [
          {
            name: 'app',
            isDir: true,
            size: 4096,
            mode: 0o755,
            permissions: 'drwxr-xr-x',
            modifiedAt: now - 3600,
          },
          {
            name: '.ssh',
            isDir: true,
            size: 4096,
            mode: 0o700,
            permissions: 'drwx------',
            modifiedAt: now - 86400,
          },
          {
            name: 'docker-compose.yml',
            isDir: false,
            size: 1842,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 1800,
          },
          {
            name: '.env',
            isDir: false,
            size: 320,
            mode: 0o600,
            permissions: '-rw-------',
            modifiedAt: now - 7200,
          },
        ],
      ],
      [
        '/home/deploy/app',
        [
          {
            name: 'server.log',
            isDir: false,
            size: 48120,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 120,
          },
          {
            name: 'config.toml',
            isDir: false,
            size: 912,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 4000,
          },
        ],
      ],
    ]);
    mockSftpTrees.set(hostId, tree);
  }
  return tree;
}

function makeUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
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
      '(Run inside Tauri desktop app for full native PTY, SSH2, and SFTP.)';
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

export const backend = {
  async createLocalTerminal(params: {
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    title?: string;
  }): Promise<SessionInfo> {
    if (isTauriRuntime()) {
      return invokeTauri<SessionInfo>('terminal_create_local', params);
    }

    const id = makeUuid();
    const info: SessionInfo = {
      id,
      kind: 'local',
      title: params.title ?? 'Local Shell',
      hostId: null,
      cols: params.cols,
      rows: params.rows,
      status: 'connected',
      createdAt: Date.now(),
    };
    const prompt = '\x1b[36mlighterm\x1b[0m:\x1b[34m~\x1b[0m$ ';
    mockSessions.set(id, { info, lineBuffer: '', cwd: '/home/lighterm', prompt });
    dispatchStatus(id, 'connected');
    dispatchOutput(
      id,
      utf8ToBase64(
        `\x1b[1;34mLighterm Preview Terminal\x1b[0m (Browser mode — type \x1b[33mhelp\x1b[0m)\r\n${prompt}`,
      ),
    );
    return info;
  },

  async createSshTerminal(params: {
    hostId?: string;
    hostConfig?: HostConfig;
    cols: number;
    rows: number;
  }): Promise<SessionInfo> {
    if (isTauriRuntime()) {
      return invokeTauri<SessionInfo>('terminal_create_ssh', params);
    }

    const hosts = readLs<HostConfig[]>(LS_HOSTS, () => []);
    const host = params.hostConfig ?? hosts.find((h) => h.id === params.hostId);
    const title = host ? host.name || `${host.username}@${host.host}` : 'SSH Session';
    const id = makeUuid();
    const info: SessionInfo = {
      id,
      kind: 'ssh',
      title,
      hostId: host?.id ?? params.hostId ?? null,
      cols: params.cols,
      rows: params.rows,
      status: 'connected',
      createdAt: Date.now(),
    };
    const user = host?.username ?? 'deploy';
    const hostLabel = host?.host ?? 'remote';
    const prompt = `\x1b[32m${user}@${hostLabel}\x1b[0m:\x1b[34m~\x1b[0m$ `;
    mockSessions.set(id, { info, lineBuffer: '', cwd: `/home/${user}`, prompt });
    dispatchStatus(id, 'connected');
    dispatchOutput(
      id,
      utf8ToBase64(
        `\x1b[1;32mConnected to ${user}@${hostLabel}:${host?.port ?? 22}\x1b[0m\r\n${prompt}`,
      ),
    );
    return info;
  },

  async writeTerminal(sessionId: string, dataBase64: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('terminal_write', { sessionId, dataBase64 });
    }

    const session = mockSessions.get(sessionId);
    if (!session) return;
    const text = new TextDecoder().decode(base64ToBytes(dataBase64));

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
  },

  async resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('terminal_resize', { sessionId, cols, rows });
    }
    const s = mockSessions.get(sessionId);
    if (s) {
      s.info.cols = cols;
      s.info.rows = rows;
    }
  },

  async closeTerminal(sessionId: string): Promise<void> {
    earlyOutputBuffer.delete(sessionId);
    if (isTauriRuntime()) {
      return invokeTauri<void>('terminal_close', { sessionId });
    }
    mockSessions.delete(sessionId);
  },

  async listHosts(): Promise<HostConfig[]> {
    if (isTauriRuntime()) {
      return invokeTauri<HostConfig[]>('hosts_list');
    }
    return readLs<HostConfig[]>(LS_HOSTS, () => []);
  },

  async saveHost(host: HostConfig): Promise<HostConfig> {
    if (isTauriRuntime()) {
      return invokeTauri<HostConfig>('hosts_save', { host });
    }
    const hosts = readLs<HostConfig[]>(LS_HOSTS, () => []);
    const saved: HostConfig = {
      ...host,
      id: host.id.trim() ? host.id : makeUuid(),
      updatedAt: Date.now(),
    };
    const idx = hosts.findIndex((h) => h.id === saved.id);
    if (idx >= 0) hosts[idx] = saved;
    else hosts.push(saved);
    writeLs(LS_HOSTS, hosts);
    return saved;
  },

  async deleteHost(id: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('hosts_delete', { id });
    }
    const hosts = readLs<HostConfig[]>(LS_HOSTS, () => []).filter((h) => h.id !== id);
    writeLs(LS_HOSTS, hosts);
  },

  async testHostConnection(host: HostConfig): Promise<ConnectionTestResult> {
    if (isTauriRuntime()) {
      return invokeTauri<ConnectionTestResult>('hosts_test_connection', { host });
    }
    return {
      success: Boolean(host.host.trim() && host.username.trim()),
      latencyMs: 18,
      message: host.host.trim()
        ? `Preview check OK for ${host.username}@${host.host}:${host.port}`
        : 'Host address cannot be empty',
    };
  },

  async sftpCanonicalize(hostId: string, path: string): Promise<string> {
    if (isTauriRuntime()) {
      return invokeTauri<string>('sftp_canonicalize', { hostId, path });
    }
    if (!path || path === '.') return '/home/deploy';
    return path.startsWith('/') ? path : `/home/deploy/${path}`;
  },

  async sftpListDir(hostId: string, path: string): Promise<SftpEntry[]> {
    if (isTauriRuntime()) {
      return invokeTauri<SftpEntry[]>('sftp_list_dir', { hostId, path });
    }
    const tree = getMockSftpTree(hostId);
    const items = tree.get(path) ?? [];
    return items
      .map((item) => ({
        name: item.name,
        path: path === '/' ? `/${item.name}` : `${path.replace(/\/+$/, '')}/${item.name}`,
        isDir: item.isDir,
        isSymlink: false,
        size: item.size,
        permissions: item.permissions,
        mode: item.mode,
        modifiedAt: item.modifiedAt,
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  },

  async sftpMkdir(hostId: string, path: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('sftp_mkdir', { hostId, path });
    }
    const tree = getMockSftpTree(hostId);
    const lastSlash = path.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const list = tree.get(parent) ?? [];
    if (!list.some((e) => e.name === name)) {
      list.push({
        name,
        isDir: true,
        size: 4096,
        mode: 0o755,
        permissions: 'drwxr-xr-x',
        modifiedAt: Math.floor(Date.now() / 1000),
      });
      tree.set(parent, list);
      tree.set(path, []);
    }
  },

  async sftpRemove(hostId: string, path: string, isDir: boolean): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('sftp_remove', { hostId, path, isDir });
    }
    const tree = getMockSftpTree(hostId);
    const lastSlash = path.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const list = (tree.get(parent) ?? []).filter((e) => e.name !== name);
    tree.set(parent, list);
    if (isDir) tree.delete(path);
  },

  async sftpRename(hostId: string, oldPath: string, newPath: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('sftp_rename', { hostId, oldPath, newPath });
    }
    const tree = getMockSftpTree(hostId);
    const oldSlash = oldPath.lastIndexOf('/');
    const parent = oldSlash <= 0 ? '/' : oldPath.slice(0, oldSlash);
    const oldName = oldPath.slice(oldSlash + 1);
    const newName = newPath.slice(newPath.lastIndexOf('/') + 1);
    const list = tree.get(parent) ?? [];
    const entry = list.find((e) => e.name === oldName);
    if (entry) entry.name = newName;
  },

  async sftpUpload(hostId: string, localPath: string, remotePath: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('sftp_upload', { hostId, localPath, remotePath });
    }
    const fileName = remotePath.split('/').pop() ?? 'upload';
    const transferId = makeUuid();
    dispatchSftpProgress({
      transferId,
      hostId,
      fileName,
      direction: 'upload',
      bytesTransferred: 1024,
      totalBytes: 1024,
      done: true,
      error: null,
    });
    const tree = getMockSftpTree(hostId);
    const lastSlash = remotePath.lastIndexOf('/');
    const parent = lastSlash <= 0 ? '/' : remotePath.slice(0, lastSlash);
    const list = tree.get(parent) ?? [];
    list.push({
      name: fileName,
      isDir: false,
      size: 1024,
      mode: 0o644,
      permissions: '-rw-r--r--',
      modifiedAt: Math.floor(Date.now() / 1000),
    });
    tree.set(parent, list);
  },

  async sftpDownload(hostId: string, remotePath: string, localPath: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('sftp_download', { hostId, remotePath, localPath });
    }
    const fileName = remotePath.split('/').pop() ?? 'download';
    dispatchSftpProgress({
      transferId: makeUuid(),
      hostId,
      fileName,
      direction: 'download',
      bytesTransferred: 2048,
      totalBytes: 2048,
      done: true,
      error: null,
    });
  },

  async listSnippets(): Promise<Snippet[]> {
    if (isTauriRuntime()) {
      return invokeTauri<Snippet[]>('snippets_list');
    }
    return readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets);
  },

  async saveSnippet(snippet: Snippet): Promise<Snippet> {
    if (isTauriRuntime()) {
      return invokeTauri<Snippet>('snippets_save', { snippet });
    }
    const list = readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets);
    const saved: Snippet = {
      ...snippet,
      id: snippet.id.trim() ? snippet.id : makeUuid(),
      updatedAt: Date.now(),
    };
    const idx = list.findIndex((s) => s.id === saved.id);
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    writeLs(LS_SNIPPETS, list);
    return saved;
  },

  async deleteSnippet(id: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('snippets_delete', { id });
    }
    const list = readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets).filter((s) => s.id !== id);
    writeLs(LS_SNIPPETS, list);
  },

  async listHistory(query?: string, limit = 200): Promise<HistoryEntry[]> {
    if (isTauriRuntime()) {
      return invokeTauri<HistoryEntry[]>('history_list', { query: query ?? null, limit });
    }
    let list = readLs<HistoryEntry[]>(LS_HISTORY, () => []);
    list = [...list].sort((a, b) => b.timestamp - a.timestamp);
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (e) => e.command.toLowerCase().includes(q) || e.hostLabel.toLowerCase().includes(q),
      );
    }
    return list.slice(0, limit);
  },

  async recordHistory(
    command: string,
    sessionKind: SessionKind,
    hostLabel: string,
  ): Promise<HistoryEntry | null> {
    if (isTauriRuntime()) {
      return invokeTauri<HistoryEntry | null>('history_record', {
        command,
        sessionKind,
        hostLabel,
      });
    }
    const trimmed = command.trim();
    if (!trimmed) return null;
    const list = readLs<HistoryEntry[]>(LS_HISTORY, () => []);
    const existing = list.find((e) => e.command === trimmed);
    let saved: HistoryEntry;
    if (existing) {
      existing.timestamp = Date.now();
      existing.count += 1;
      existing.sessionKind = sessionKind;
      existing.hostLabel = hostLabel;
      saved = existing;
    } else {
      saved = {
        id: makeUuid(),
        command: trimmed,
        sessionKind,
        hostLabel,
        timestamp: Date.now(),
        count: 1,
      };
      list.unshift(saved);
    }
    writeLs(LS_HISTORY, list.slice(0, 1000));
    return saved;
  },

  async deleteHistory(id: string): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('history_delete', { id });
    }
    const list = readLs<HistoryEntry[]>(LS_HISTORY, () => []).filter((e) => e.id !== id);
    writeLs(LS_HISTORY, list);
  },

  async clearHistory(): Promise<void> {
    if (isTauriRuntime()) {
      return invokeTauri<void>('history_clear');
    }
    writeLs(LS_HISTORY, []);
  },

  async getSettings(): Promise<AppSettings> {
    if (isTauriRuntime()) {
      return invokeTauri<AppSettings>('settings_get');
    }
    return readLs<AppSettings>(LS_SETTINGS, createDefaultSettings);
  },

  async saveSettings(settings: AppSettings): Promise<AppSettings> {
    if (isTauriRuntime()) {
      return invokeTauri<AppSettings>('settings_save', { settings });
    }
    writeLs(LS_SETTINGS, settings);
    return settings;
  },

  async getSystemStats(params: {
    kind: SessionKind;
    hostId?: string;
    hostConfig?: HostConfig;
  }): Promise<SystemStats> {
    if (isTauriRuntime()) {
      return invokeTauri<SystemStats>('monitor_get_stats', params);
    }

    const now = Date.now();
    const wave = (Math.sin(now / 1800) + 1) * 0.5;
    const isSsh = params.kind === 'ssh';
    const hostLabel = params.hostConfig?.host ?? (isSsh ? 'prod-node-01' : 'lighterm-local');
    const cpuUsage = Number((14 + wave * 34).toFixed(1));
    const totalMem = isSsh ? 16 * 1024 ** 3 : 32 * 1024 ** 3;
    const usedMem = Math.round(totalMem * (0.42 + wave * 0.14));

    return {
      source: params.kind,
      hostname: hostLabel,
      osName: isSsh ? 'Debian GNU/Linux 13' : 'Deepin 25',
      kernelVersion: '6.12.0-amd64',
      arch: 'x86_64',
      uptimeSecs: isSsh ? 842100 : 19420,
      loadAvg: [0.68 + wave * 0.4, 0.54, 0.41],
      cpuUsagePercent: cpuUsage,
      cpuCores: isSsh ? 8 : 16,
      memTotalBytes: totalMem,
      memUsedBytes: usedMem,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 128 * 1024 ** 2,
      netRxBytesPerSec: Math.round(24_000 + wave * 420_000),
      netTxBytesPerSec: Math.round(8_500 + wave * 110_000),
      netTotalRxBytes: 1_840_000_000,
      netTotalTxBytes: 620_000_000,
      disks: [
        {
          name: '/dev/nvme0n1p2',
          mountPoint: '/',
          fsType: 'ext4',
          totalBytes: 512 * 1024 ** 3,
          usedBytes: 214 * 1024 ** 3,
          usagePercent: 41.8,
        },
        {
          name: '/dev/sda1',
          mountPoint: '/data',
          fsType: 'xfs',
          totalBytes: 1024 * 1024 ** 3,
          usedBytes: 640 * 1024 ** 3,
          usagePercent: 62.5,
        },
      ],
      topProcesses: [
        { pid: 1420, name: isSsh ? 'nginx' : 'lighterm', cpuPercent: 6.4, memoryBytes: 245 * 1024 ** 2 },
        { pid: 2104, name: isSsh ? 'postgres' : 'rust-analyzer', cpuPercent: 4.1, memoryBytes: 512 * 1024 ** 2 },
        { pid: 882, name: 'systemd', cpuPercent: 0.6, memoryBytes: 38 * 1024 ** 2 },
      ],
      sampledAt: now,
    };
  },
};
