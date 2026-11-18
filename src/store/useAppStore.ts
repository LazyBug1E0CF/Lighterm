import { create } from 'zustand';
import {
  backend,
  subscribeSftpProgress,
  subscribeTerminalExit,
  subscribeTerminalStatus,
} from '../services/backend';
import type {
  AppSettings,
  ConnectionTestResult,
  HistoryEntry,
  HostConfig,
  PaneLeaf,
  SessionKind,
  SessionStatus,
  SftpEntry,
  SftpTransferProgress,
  Snippet,
  SplitDirection,
  TerminalTab,
} from '../types';
import { utf8ToBase64 } from '../utils/base64';
import {
  collectLeaves,
  findFirstLeaf,
  findLeafById,
  removePaneNode,
  splitPaneNode,
  updateSplitRatio,
} from '../utils/paneTree';
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts';

export type SidebarSection = 'hosts' | 'snippets' | 'history' | null;

function newId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 9)}`;
}

const DEFAULT_SETTINGS: AppSettings = {
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

interface AppState {
  initialized: boolean;
  tabs: TerminalTab[];
  activeTabId: string | null;
  sessionStatuses: Record<string, SessionStatus>;
  sessionMessages: Record<string, string | undefined>;
  sessionDimensions: Record<string, { cols: number; rows: number }>;

  hosts: HostConfig[];
  hostModalOpen: boolean;
  editingHost: HostConfig | null;

  snippets: Snippet[];
  history: HistoryEntry[];
  settings: AppSettings;

  activeSidebarTab: SidebarSection;
  monitorOpen: boolean;
  sftpOpen: boolean;
  sftpHostId: string | null;
  sftpPath: string;
  sftpEntries: SftpEntry[];
  sftpLoading: boolean;
  sftpError: string | null;
  sftpShowHidden: boolean;
  sftpTransfers: SftpTransferProgress[];

  settingsModalOpen: boolean;
  commandPaletteOpen: boolean;
  terminalSearchSignal: number;
  statusBannerError: string | null;

  initializeApp: () => Promise<void>;
  clearBannerError: () => void;

  openLocalTab: (cwd?: string, title?: string) => Promise<void>;
  openSshTab: (host: HostConfig) => Promise<void>;
  quickConnectSsh: (rawInput: string) => Promise<void>;
  splitActivePane: (direction: SplitDirection, host?: HostConfig) => Promise<void>;
  closePane: (tabId: string, paneId: string) => Promise<void>;
  closeTab: (tabId: string) => Promise<void>;
  setActiveTab: (tabId: string) => void;
  cycleTab: (delta: 1 | -1) => void;
  setActivePane: (tabId: string, paneId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  setSplitRatio: (tabId: string, splitId: string, ratio: number) => void;
  setSessionDimensions: (sessionId: string, cols: number, rows: number) => void;

  openHostModal: (host?: HostConfig | null) => void;
  closeHostModal: () => void;
  saveHost: (host: HostConfig) => Promise<HostConfig>;
  deleteHost: (id: string) => Promise<void>;
  testHostConnection: (host: HostConfig) => Promise<ConnectionTestResult>;

  saveSnippet: (snippet: Snippet) => Promise<Snippet>;
  deleteSnippet: (id: string) => Promise<void>;
  sendTextToActivePane: (text: string, appendNewline?: boolean) => Promise<void>;

  recordCommand: (command: string, kind: SessionKind, hostLabel: string) => Promise<void>;
  refreshHistory: (query?: string) => Promise<void>;
  deleteHistoryItem: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  setSidebarTab: (tab: SidebarSection) => void;
  toggleSidebar: () => void;
  toggleMonitorPanel: () => void;
  setSettingsModalOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  triggerTerminalSearch: () => void;

  toggleSftpDrawer: () => Promise<void>;
  openSftpForHost: (hostId: string, initialPath?: string) => Promise<void>;
  navigateSftp: (path: string) => Promise<void>;
  refreshSftp: () => Promise<void>;
  toggleSftpHidden: () => void;
  mkdirSftp: (name: string) => Promise<void>;
  removeSftp: (entry: SftpEntry) => Promise<void>;
  renameSftp: (entry: SftpEntry, newName: string) => Promise<void>;
  uploadSftp: (localPath: string, fileName: string) => Promise<void>;
  downloadSftp: (entry: SftpEntry, localPath: string) => Promise<void>;

  getActivePane: () => PaneLeaf | null;
}

let initPromise: Promise<void> | null = null;

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  tabs: [],
  activeTabId: null,
  sessionStatuses: {},
  sessionMessages: {},
  sessionDimensions: {},

  hosts: [],
  hostModalOpen: false,
  editingHost: null,

  snippets: [],
  history: [],
  settings: DEFAULT_SETTINGS,

  activeSidebarTab: 'hosts',
  monitorOpen: true,
  sftpOpen: false,
  sftpHostId: null,
  sftpPath: '.',
  sftpEntries: [],
  sftpLoading: false,
  sftpError: null,
  sftpShowHidden: false,
  sftpTransfers: [],

  settingsModalOpen: false,
  commandPaletteOpen: false,
  terminalSearchSignal: 0,
  statusBannerError: null,

  initializeApp: async () => {
    if (get().initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      subscribeTerminalStatus((sessionId, status, message) => {
        set((state) => ({
          sessionStatuses: { ...state.sessionStatuses, [sessionId]: status },
          sessionMessages: { ...state.sessionMessages, [sessionId]: message },
        }));
      });

      subscribeTerminalExit((sessionId) => {
        set((state) => ({
          sessionStatuses: { ...state.sessionStatuses, [sessionId]: 'disconnected' },
        }));
      });

      subscribeSftpProgress((progress) => {
        set((state) => {
          const existingIdx = state.sftpTransfers.findIndex(
            (t) => t.transferId === progress.transferId,
          );
          const next = [...state.sftpTransfers];
          if (existingIdx >= 0) next[existingIdx] = progress;
          else next.unshift(progress);
          return { sftpTransfers: next.slice(0, 8) };
        });
      });

      const [settings, hosts, snippets, history] = await Promise.all([
        backend.getSettings().catch(() => DEFAULT_SETTINGS),
        backend.listHosts().catch(() => [] as HostConfig[]),
        backend.listSnippets().catch(() => [] as Snippet[]),
        backend.listHistory(undefined, 200).catch(() => [] as HistoryEntry[]),
      ]);

      set({
        settings: { ...DEFAULT_SETTINGS, ...settings, shortcuts: { ...DEFAULT_SHORTCUTS, ...settings.shortcuts } },
        hosts,
        snippets,
        history,
        initialized: true,
      });

      if (get().tabs.length === 0) {
        await get().openLocalTab();
      }
    })();

    return initPromise;
  },

  clearBannerError: () => set({ statusBannerError: null }),

  openLocalTab: async (cwd, title) => {
    const count = get().tabs.length + 1;
    const tabTitle = title ?? `Terminal ${count}`;
    try {
      const session = await backend.createLocalTerminal({
        cols: 100,
        rows: 30,
        cwd,
        title: tabTitle,
      });
      const leaf: PaneLeaf = {
        type: 'leaf',
        id: newId('pane'),
        sessionId: session.id,
        kind: 'local',
        title: tabTitle,
      };
      const tab: TerminalTab = {
        id: newId('tab'),
        title: tabTitle,
        root: leaf,
        activePaneId: leaf.id,
      };
      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        sessionStatuses: { ...state.sessionStatuses, [session.id]: session.status },
        sessionDimensions: { ...state.sessionDimensions, [session.id]: { cols: 100, rows: 30 } },
        statusBannerError: null,
      }));
    } catch (err) {
      set({ statusBannerError: err instanceof Error ? err.message : String(err) });
    }
  },

  openSshTab: async (host) => {
    try {
      const session = await backend.createSshTerminal({
        hostId: host.id || undefined,
        hostConfig: host,
        cols: 100,
        rows: 30,
      });
      const title = host.name || `${host.username}@${host.host}`;
      const leaf: PaneLeaf = {
        type: 'leaf',
        id: newId('pane'),
        sessionId: session.id,
        kind: 'ssh',
        hostId: host.id || undefined,
        hostConfig: host,
        title,
      };
      const tab: TerminalTab = {
        id: newId('tab'),
        title,
        root: leaf,
        activePaneId: leaf.id,
      };
      set((state) => ({
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
        sessionStatuses: { ...state.sessionStatuses, [session.id]: session.status },
        sessionDimensions: { ...state.sessionDimensions, [session.id]: { cols: 100, rows: 30 } },
        statusBannerError: null,
      }));
    } catch (err) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      set({ statusBannerError: `SSH connection failed: ${message}` });
    }
  },

  quickConnectSsh: async (rawInput) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    const matchedHost = get().hosts.find(
      (h) =>
        h.name.toLowerCase() === trimmed.toLowerCase() ||
        h.host.toLowerCase() === trimmed.toLowerCase(),
    );
    if (matchedHost) {
      await get().openSshTab(matchedHost);
      return;
    }

    const parsed = parseQuickSshInput(trimmed);
    if (!parsed) {
      set({
        statusBannerError: 'Quick SSH format: user@host[:port] or ssh -p 2222 user@host',
      });
      return;
    }

    const tempHost: HostConfig = {
      id: newId('quick'),
      name: `${parsed.username}@${parsed.host}`,
      group: 'Quick Connect',
      host: parsed.host,
      port: parsed.port,
      username: parsed.username,
      auth: { type: 'privateKey' },
      updatedAt: Date.now(),
    };
    await get().openSshTab(tempHost);
  },

  splitActivePane: async (direction, host) => {
    const state = get();
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!activeTab) {
      await (host ? state.openSshTab(host) : state.openLocalTab());
      return;
    }

    const activeLeaf = findLeafById(activeTab.root, activeTab.activePaneId) ?? findFirstLeaf(activeTab.root);
    const targetHost =
      host ??
      (activeLeaf.kind === 'ssh'
        ? (activeLeaf.hostId
            ? state.hosts.find((h) => h.id === activeLeaf.hostId) ?? activeLeaf.hostConfig
            : activeLeaf.hostConfig)
        : undefined);

    try {
      const session = targetHost
        ? await backend.createSshTerminal({
            hostId: targetHost.id,
            hostConfig: targetHost,
            cols: 80,
            rows: 24,
          })
        : await backend.createLocalTerminal({
            cols: 80,
            rows: 24,
            title: 'Local Shell',
          });

      const newLeaf: PaneLeaf = {
        type: 'leaf',
        id: newId('pane'),
        sessionId: session.id,
        kind: targetHost ? 'ssh' : 'local',
        hostId: targetHost?.id,
        hostConfig: targetHost,
        title: targetHost ? targetHost.name || `${targetHost.username}@${targetHost.host}` : 'Local Shell',
      };

      const nextRoot = splitPaneNode(
        activeTab.root,
        activeLeaf.id,
        direction,
        newLeaf,
        newId('split'),
      );

      set((prev) => ({
        tabs: prev.tabs.map((t) =>
          t.id === activeTab.id ? { ...t, root: nextRoot, activePaneId: newLeaf.id } : t,
        ),
        sessionStatuses: { ...prev.sessionStatuses, [session.id]: session.status },
        sessionDimensions: { ...prev.sessionDimensions, [session.id]: { cols: 80, rows: 24 } },
        statusBannerError: null,
      }));
    } catch (err) {
      set({ statusBannerError: err instanceof Error ? err.message : String(err) });
    }
  },

  closePane: async (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const leaf = findLeafById(tab.root, paneId);
    if (leaf) {
      await backend.closeTerminal(leaf.sessionId).catch(() => {});
    }

    const nextRoot = removePaneNode(tab.root, paneId);
    if (!nextRoot) {
      await get().closeTab(tabId);
      return;
    }

    const remainingLeaves = collectLeaves(nextRoot);
    const nextActivePane =
      tab.activePaneId === paneId ? remainingLeaves[0].id : tab.activePaneId;

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, root: nextRoot, activePaneId: nextActivePane } : t,
      ),
    }));
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const leaves = collectLeaves(tab.root);
    await Promise.all(leaves.map((l) => backend.closeTerminal(l.sessionId).catch(() => {})));

    const currentTabs = get().tabs;
    const idx = currentTabs.findIndex((t) => t.id === tabId);
    const nextTabs = currentTabs.filter((t) => t.id !== tabId);

    let nextActiveTabId = get().activeTabId;
    if (nextActiveTabId === tabId) {
      nextActiveTabId = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null;
    }

    set({ tabs: nextTabs, activeTabId: nextActiveTabId });
    if (nextTabs.length === 0) {
      await get().openLocalTab();
    }
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  cycleTab: (delta) => {
    const { tabs, activeTabId } = get();
    if (tabs.length <= 1 || !activeTabId) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    if (idx < 0) return;
    const nextIdx = (idx + delta + tabs.length) % tabs.length;
    set({ activeTabId: tabs[nextIdx].id });
  },

  setActivePane: (tabId, paneId) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
    }));
  },

  renameTab: (tabId, title) => {
    const clean = title.trim();
    if (!clean) return;
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title: clean } : t)),
    }));
  },

  setSplitRatio: (tabId, splitId, ratio) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, root: updateSplitRatio(t.root, splitId, ratio) } : t,
      ),
    }));
  },

  setSessionDimensions: (sessionId, cols, rows) => {
    set((state) => ({
      sessionDimensions: { ...state.sessionDimensions, [sessionId]: { cols, rows } },
    }));
  },

  openHostModal: (host = null) => set({ hostModalOpen: true, editingHost: host }),
  closeHostModal: () => set({ hostModalOpen: false, editingHost: null }),

  saveHost: async (host) => {
    const saved = await backend.saveHost(host);
    const hosts = await backend.listHosts();
    set({ hosts, hostModalOpen: false, editingHost: null });
    return saved;
  },

  deleteHost: async (id) => {
    await backend.deleteHost(id);
    const hosts = await backend.listHosts();
    set((state) => ({
      hosts,
      sftpHostId: state.sftpHostId === id ? null : state.sftpHostId,
    }));
  },

  testHostConnection: (host) => backend.testHostConnection(host),

  saveSnippet: async (snippet) => {
    const saved = await backend.saveSnippet(snippet);
    const snippets = await backend.listSnippets();
    set({ snippets });
    return saved;
  },

  deleteSnippet: async (id) => {
    await backend.deleteSnippet(id);
    const snippets = await backend.listSnippets();
    set({ snippets });
  },

  sendTextToActivePane: async (text, appendNewline = false) => {
    const pane = get().getActivePane();
    if (!pane) return;
    const payload = appendNewline ? `${text}\n` : text;
    await backend.writeTerminal(pane.sessionId, utf8ToBase64(payload));
  },

  recordCommand: async (command, kind, hostLabel) => {
    const saved = await backend.recordHistory(command, kind, hostLabel);
    if (!saved) return;
    const history = await backend.listHistory(undefined, 200);
    set({ history });
  },

  refreshHistory: async (query) => {
    const history = await backend.listHistory(query, 200);
    set({ history });
  },

  deleteHistoryItem: async (id) => {
    await backend.deleteHistory(id);
    const history = await backend.listHistory(undefined, 200);
    set({ history });
  },

  clearHistory: async () => {
    await backend.clearHistory();
    set({ history: [] });
  },

  updateSettings: async (partial) => {
    const merged: AppSettings = {
      ...get().settings,
      ...partial,
      shortcuts: {
        ...get().settings.shortcuts,
        ...(partial.shortcuts ?? {}),
      },
    };
    const saved = await backend.saveSettings(merged);
    set({ settings: saved });
  },

  setSidebarTab: (tab) => {
    set((state) => ({
      activeSidebarTab: state.activeSidebarTab === tab ? null : tab,
    }));
  },

  toggleSidebar: () => {
    set((state) => ({
      activeSidebarTab: state.activeSidebarTab ? null : 'hosts',
    }));
  },

  toggleMonitorPanel: () => {
    set((state) => ({ monitorOpen: !state.monitorOpen }));
  },

  setSettingsModalOpen: (open) => set({ settingsModalOpen: open }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  triggerTerminalSearch: () => set((state) => ({ terminalSearchSignal: state.terminalSearchSignal + 1 })),

  toggleSftpDrawer: async () => {
    const state = get();
    if (state.sftpOpen) {
      set({ sftpOpen: false });
      return;
    }

    const activePane = state.getActivePane();
    const activeSavedHostId =
      activePane?.kind === 'ssh' &&
      activePane.hostId &&
      state.hosts.some((h) => h.id === activePane.hostId)
        ? activePane.hostId
        : null;
    const targetHostId = activeSavedHostId ?? state.sftpHostId ?? state.hosts[0]?.id ?? null;

    set({ sftpOpen: true });
    if (targetHostId) {
      await get().openSftpForHost(targetHostId);
    }
  },

  openSftpForHost: async (hostId, initialPath) => {
    const host = get().hosts.find((h) => h.id === hostId);
    const requestedPath = initialPath ?? host?.defaultPath ?? '.';
    set({ sftpOpen: true, sftpHostId: hostId, sftpLoading: true, sftpError: null });

    try {
      const canonical = await backend.sftpCanonicalize(hostId, requestedPath);
      const entries = await backend.sftpListDir(hostId, canonical);
      set({ sftpPath: canonical, sftpEntries: entries, sftpLoading: false });
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      set({ sftpLoading: false, sftpError: msg });
    }
  },

  navigateSftp: async (path) => {
    const hostId = get().sftpHostId;
    if (!hostId) return;
    set({ sftpLoading: true, sftpError: null });
    try {
      const canonical = await backend.sftpCanonicalize(hostId, path);
      const entries = await backend.sftpListDir(hostId, canonical);
      set({ sftpPath: canonical, sftpEntries: entries, sftpLoading: false });
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      set({ sftpLoading: false, sftpError: msg });
    }
  },

  refreshSftp: async () => {
    const { sftpHostId, sftpPath } = get();
    if (!sftpHostId) return;
    await get().navigateSftp(sftpPath);
  },

  toggleSftpHidden: () => set((state) => ({ sftpShowHidden: !state.sftpShowHidden })),

  mkdirSftp: async (name) => {
    const { sftpHostId, sftpPath } = get();
    if (!sftpHostId || !name.trim()) return;
    const clean = name.trim().replace(/^\/+|\/+$/g, '');
    const target = sftpPath === '/' ? `/${clean}` : `${sftpPath.replace(/\/+$/, '')}/${clean}`;
    await backend.sftpMkdir(sftpHostId, target);
    await get().refreshSftp();
  },

  removeSftp: async (entry) => {
    const { sftpHostId } = get();
    if (!sftpHostId) return;
    await backend.sftpRemove(sftpHostId, entry.path, entry.isDir);
    await get().refreshSftp();
  },

  renameSftp: async (entry, newName) => {
    const { sftpHostId, sftpPath } = get();
    if (!sftpHostId || !newName.trim()) return;
    const clean = newName.trim().replace(/\//g, '');
    const nextPath = sftpPath === '/' ? `/${clean}` : `${sftpPath.replace(/\/+$/, '')}/${clean}`;
    await backend.sftpRename(sftpHostId, entry.path, nextPath);
    await get().refreshSftp();
  },

  uploadSftp: async (localPath, fileName) => {
    const { sftpHostId, sftpPath } = get();
    if (!sftpHostId) return;
    const remotePath =
      sftpPath === '/' ? `/${fileName}` : `${sftpPath.replace(/\/+$/, '')}/${fileName}`;
    await backend.sftpUpload(sftpHostId, localPath, remotePath);
    await get().refreshSftp();
  },

  downloadSftp: async (entry, localPath) => {
    const { sftpHostId } = get();
    if (!sftpHostId) return;
    await backend.sftpDownload(sftpHostId, entry.path, localPath);
  },

  getActivePane: () => {
    const { tabs, activeTabId } = get();
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return null;
    return findLeafById(tab.root, tab.activePaneId) ?? findFirstLeaf(tab.root);
  },
}));
