import type { ITheme } from '@xterm/xterm';

export type SessionKind = 'local' | 'ssh';
export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  title: string;
  hostId?: string | null;
  cols: number;
  rows: number;
  status: SessionStatus;
  createdAt: number;
}

export type AuthMethod =
  | { type: 'password'; password?: string | null }
  | {
      type: 'privateKey';
      keyPath?: string | null;
      privateKeyPem?: string | null;
      passphrase?: string | null;
    };

export interface HostConfig {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  defaultPath?: string | null;
  startupCommand?: string | null;
  color?: string | null;
  updatedAt: number;
}

export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  permissions: string;
  mode: number;
  modifiedAt?: number | null;
}

export interface SftpTransferProgress {
  transferId: string;
  hostId: string;
  fileName: string;
  direction: 'upload' | 'download' | string;
  bytesTransferred: number;
  totalBytes: number;
  done: boolean;
  error?: string | null;
}

export interface Snippet {
  id: string;
  title: string;
  command: string;
  category: string;
  description?: string | null;
  autoExecute: boolean;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  command: string;
  sessionKind: SessionKind;
  hostLabel: string;
  timestamp: number;
  count: number;
}

export interface ShortcutMap {
  newLocalTab: string;
  newHostModal: string;
  splitHorizontal: string;
  splitVertical: string;
  closePane: string;
  findInTerminal: string;
  commandPalette: string;
  toggleSidebar: string;
  toggleSftp: string;
  toggleMonitor: string;
  openPlugins: string;
  openSettings: string;
  nextTab: string;
  prevTab: string;
}

export interface AppSettings {
  themeId: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: 'block' | 'underline' | 'bar' | string;
  cursorBlink: boolean;
  scrollback: number;
  backgroundOpacity: number;
  copyOnSelect: boolean;
  shortcuts: ShortcutMap;
}

export interface ConnectionTestResult {
  success: boolean;
  latencyMs: number;
  message: string;
}

export interface BackendPluginInfo {
  id: string;
  name: string;
  version?: string;
  description: string;
  enabled: boolean;
  alwaysOn?: boolean;
  dependencies: string[];
}

export interface DiskStat {
  name: string;
  mountPoint: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  usagePercent: number;
}

export interface ProcessStat {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
}

export interface SystemStats {
  source: SessionKind;
  hostname: string;
  osName: string;
  kernelVersion: string;
  arch: string;
  uptimeSecs: number;
  loadAvg: [number, number, number];
  cpuUsagePercent: number;
  cpuCores: number;
  memTotalBytes: number;
  memUsedBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  netTotalRxBytes: number;
  netTotalTxBytes: number;
  disks: DiskStat[];
  topProcesses: ProcessStat[];
  sampledAt: number;
}

export type SplitDirection = 'horizontal' | 'vertical';

export type QuickShellLayoutPreset = 'tab' | 'vsp' | 'hsp' | 'grid';

export interface SavedTerminalSlot {
  slotId: string;
  title: string;
  kind: SessionKind;
  hostId?: string;
  cwd?: string;
  shell?: string;
}

export type SavedDockNode =
  | {
      type: 'group';
      slotIds: string[];
      activeSlotId?: string | null;
    }
  | {
      type: 'split';
      direction: SplitDirection;
      ratio: number;
      first: SavedDockNode;
      second: SavedDockNode;
    };

export interface SavedFloatingSlot {
  slotId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
}

export interface SavedWorkspace {
  id: string;
  name: string;
  slots: SavedTerminalSlot[];
  dockRoot: SavedDockNode | null;
  floating: SavedFloatingSlot[];
  activeSlotId?: string | null;
  maximizedSlotId?: string | null;
  layoutPreset?: QuickShellLayoutPreset | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThemePreset {
  id: string;
  name: string;
  isDark: boolean;
  ui: {
    bgApp: string;
    bgSurface: string;
    bgElevated: string;
    borderSubtle: string;
    textPrimary: string;
    textMuted: string;
    accent: string;
    danger: string;
    success: string;
    warning: string;
  };
  xterm: ITheme;
}
