import { create } from 'zustand';
import { writeLs } from '../../core/ipc';
import type { ViewportPosition } from '../../harness/types';

export const LS_MONITOR_PANELS = 'lighterm:monitor-panels';
export const MONITOR_PROCESSES_VIEWPORT_TYPE = 'monitor.processes';

export interface MonitorPluginConfig extends Record<string, unknown> {
  pollIntervalMs: number;
  defaultProcessSort: 'cpu' | 'mem';
}

export const DEFAULT_MONITOR_CONFIG: MonitorPluginConfig = {
  pollIntervalMs: 2500,
  defaultProcessSort: 'cpu',
};

export type MonitorPanelId = 'host' | 'cpu' | 'memory' | 'network' | 'disks' | 'processes';

export type MonitorPanelViewportType = `monitor.${MonitorPanelId}`;

export function getMonitorPanelViewportType(id: MonitorPanelId): MonitorPanelViewportType {
  return `monitor.${id}`;
}

export interface MonitorPanelMeta {
  id: MonitorPanelId;
  viewportTypeId: MonitorPanelViewportType;
  title: string;
  description: string;
  defaultPosition: ViewportPosition;
  defaultDockRatio?: number;
  defaultFloatSize: { width: number; height: number };
  order: number;
}

export const MONITOR_PANEL_CATALOG: readonly MonitorPanelMeta[] = [
  {
    id: 'host',
    viewportTypeId: 'monitor.host',
    title: 'Host Overview',
    description: 'Hostname, OS, kernel, uptime & load',
    defaultPosition: 'right-drawer',
    defaultFloatSize: { width: 320, height: 220 },
    order: 11,
  },
  {
    id: 'cpu',
    viewportTypeId: 'monitor.cpu',
    title: 'CPU',
    description: 'Core count, usage meter & sparkline',
    defaultPosition: 'right-drawer',
    defaultFloatSize: { width: 320, height: 210 },
    order: 12,
  },
  {
    id: 'memory',
    viewportTypeId: 'monitor.memory',
    title: 'Memory & Swap',
    description: 'RAM and swap utilization',
    defaultPosition: 'right-drawer',
    defaultFloatSize: { width: 320, height: 230 },
    order: 13,
  },
  {
    id: 'network',
    viewportTypeId: 'monitor.network',
    title: 'Network',
    description: 'Live RX/TX throughput & totals',
    defaultPosition: 'right-drawer',
    defaultFloatSize: { width: 320, height: 220 },
    order: 14,
  },
  {
    id: 'disks',
    viewportTypeId: 'monitor.disks',
    title: 'Disks',
    description: 'Mounted filesystems & capacity',
    defaultPosition: 'right-drawer',
    defaultFloatSize: { width: 340, height: 250 },
    order: 15,
  },
  {
    id: 'processes',
    viewportTypeId: 'monitor.processes',
    title: 'Top Processes',
    description: 'Highest CPU & memory processes',
    defaultPosition: 'right-drawer',
    defaultDockRatio: 0.68,
    defaultFloatSize: { width: 420, height: 340 },
    order: 16,
  },
];

export const MONITOR_PANEL_META_MAP: Record<MonitorPanelId, MonitorPanelMeta> = {
  host: MONITOR_PANEL_CATALOG[0],
  cpu: MONITOR_PANEL_CATALOG[1],
  memory: MONITOR_PANEL_CATALOG[2],
  network: MONITOR_PANEL_CATALOG[3],
  disks: MONITOR_PANEL_CATALOG[4],
  processes: MONITOR_PANEL_CATALOG[5],
};

export const DEFAULT_MONITOR_PANELS: readonly MonitorPanelId[] = [
  'host',
  'cpu',
  'memory',
  'network',
  'disks',
  'processes',
];

const VALID_PANEL_IDS = new Set<string>(DEFAULT_MONITOR_PANELS);

export function isValidMonitorPanelId(value: unknown): value is MonitorPanelId {
  return typeof value === 'string' && VALID_PANEL_IDS.has(value);
}

/**
 * Sanitizes a persisted panel order: filters unknown IDs, deduplicates,
 * and preserves an intentional empty array `[]` when all panels were deleted.
 */
export function sanitizePanelOrder(raw: unknown): MonitorPanelId[] {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_MONITOR_PANELS];
  }
  const seen = new Set<MonitorPanelId>();
  const result: MonitorPanelId[] = [];
  for (const item of raw) {
    if (isValidMonitorPanelId(item) && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function readMonitorPanels(): MonitorPanelId[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return [...DEFAULT_MONITOR_PANELS];
    }
    const raw = window.localStorage.getItem(LS_MONITOR_PANELS);
    if (raw === null) {
      return [...DEFAULT_MONITOR_PANELS];
    }
    return sanitizePanelOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_MONITOR_PANELS];
  }
}

/**
 * Moves `draggedId` to insertion slot `rawSlotIndex` (0..panels.length).
 * Returns the original array unchanged when the drop slot is a no-op or ID is missing.
 */
export function movePanelBySlot(
  panels: readonly MonitorPanelId[],
  draggedId: MonitorPanelId,
  rawSlotIndex: number,
): MonitorPanelId[] {
  const fromIndex = panels.indexOf(draggedId);
  if (fromIndex < 0) {
    return panels as MonitorPanelId[];
  }
  const slot = Math.max(0, Math.min(panels.length, Math.round(rawSlotIndex)));
  if (slot === fromIndex || slot === fromIndex + 1) {
    return panels as MonitorPanelId[];
  }
  const next = [...panels];
  next.splice(fromIndex, 1);
  const insertIdx = slot > fromIndex ? slot - 1 : slot;
  next.splice(insertIdx, 0, draggedId);
  return next;
}

/**
 * Moves `draggedId` directly to target destination index (0..panels.length-1).
 * Returns the original array unchanged when already at `targetIndex` or ID is missing.
 */
export function movePanelToIndex(
  panels: readonly MonitorPanelId[],
  draggedId: MonitorPanelId,
  targetIndex: number,
): MonitorPanelId[] {
  const fromIndex = panels.indexOf(draggedId);
  if (fromIndex < 0) {
    return panels as MonitorPanelId[];
  }
  const clamped = Math.max(0, Math.min(panels.length - 1, Math.round(targetIndex)));
  if (clamped === fromIndex) {
    return panels as MonitorPanelId[];
  }
  const next = [...panels];
  next.splice(fromIndex, 1);
  next.splice(clamped, 0, draggedId);
  return next;
}

export function isDefaultPanelOrder(panels: readonly MonitorPanelId[]): boolean {
  if (panels.length !== DEFAULT_MONITOR_PANELS.length) return false;
  return DEFAULT_MONITOR_PANELS.every((id, idx) => panels[idx] === id);
}

export const useMonitorPanelStore = create<{ panels: MonitorPanelId[] }>(() => ({
  panels: readMonitorPanels(),
}));

function commitPanels(next: MonitorPanelId[]): void {
  useMonitorPanelStore.setState({ panels: next });
  writeLs(LS_MONITOR_PANELS, next);
}

export const monitorPanelService = {
  getPanels(): MonitorPanelId[] {
    return useMonitorPanelStore.getState().panels;
  },

  addPanel(id: MonitorPanelId, index?: number): void {
    if (!isValidMonitorPanelId(id)) return;
    const current = useMonitorPanelStore.getState().panels;
    if (current.includes(id)) return;
    const next = [...current];
    if (typeof index === 'number' && Number.isFinite(index)) {
      const clamped = Math.max(0, Math.min(next.length, Math.round(index)));
      next.splice(clamped, 0, id);
    } else {
      next.push(id);
    }
    commitPanels(next);
  },

  removePanel(id: MonitorPanelId): void {
    const current = useMonitorPanelStore.getState().panels;
    if (!current.includes(id)) return;
    commitPanels(current.filter((item) => item !== id));
  },

  movePanelToSlot(id: MonitorPanelId, slotIndex: number): void {
    const current = useMonitorPanelStore.getState().panels;
    const next = movePanelBySlot(current, id, slotIndex);
    if (next === current) return;
    commitPanels(next);
  },

  movePanelToIndex(id: MonitorPanelId, targetIndex: number): void {
    const current = useMonitorPanelStore.getState().panels;
    const next = movePanelToIndex(current, id, targetIndex);
    if (next === current) return;
    commitPanels(next);
  },

  movePanelByDelta(id: MonitorPanelId, delta: -1 | 1): void {
    const current = useMonitorPanelStore.getState().panels;
    const idx = current.indexOf(id);
    if (idx < 0) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(idx, 1);
    next.splice(targetIdx, 0, moved);
    commitPanels(next);
  },

  addAllPanels(): void {
    const current = useMonitorPanelStore.getState().panels;
    const missing = DEFAULT_MONITOR_PANELS.filter((id) => !current.includes(id));
    if (missing.length === 0) return;
    commitPanels([...current, ...missing]);
  },

  resetPanels(): void {
    commitPanels([...DEFAULT_MONITOR_PANELS]);
  },

  reloadFromStorage(): void {
    useMonitorPanelStore.setState({ panels: readMonitorPanels() });
  },

  resetForTesting(): void {
    useMonitorPanelStore.setState({ panels: readMonitorPanels() });
  },
};
