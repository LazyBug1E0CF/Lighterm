import { create } from 'zustand';
import { invokeTauri, isTauriRuntime, makeUuid, readLs, writeLs } from '../../core/ipc';
import type { HistoryEntry, SessionKind } from '../../types';

const LS_HISTORY = 'lighterm:history';

export interface HistoryPluginConfig extends Record<string, unknown> {
  maxDisplayEntries: number;
  paletteHistoryLimit: number;
}

export const DEFAULT_HISTORY_CONFIG: HistoryPluginConfig = {
  maxDisplayEntries: 200,
  paletteHistoryLimit: 20,
};

export const useHistoryPluginStore = create<{ history: HistoryEntry[] }>(() => ({
  history: [],
}));

const changeListeners = new Set<(entries: HistoryEntry[]) => void>();

export const historyClient = {
  onChange(cb: (entries: HistoryEntry[]) => void): () => void {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  },

  async load(query?: string, limit = 200): Promise<HistoryEntry[]> {
    let entries: HistoryEntry[];
    if (isTauriRuntime()) {
      entries = await invokeTauri<HistoryEntry[]>('history_list', {
        query: query ?? null,
        limit,
      });
    } else {
      let list = readLs<HistoryEntry[]>(LS_HISTORY, () => []);
      list = [...list].sort((a, b) => b.timestamp - a.timestamp);
      if (query && query.trim()) {
        const q = query.trim().toLowerCase();
        list = list.filter(
          (e) => e.command.toLowerCase().includes(q) || e.hostLabel.toLowerCase().includes(q),
        );
      }
      entries = list.slice(0, limit);
    }
    useHistoryPluginStore.setState({ history: entries });
    changeListeners.forEach((cb) => cb(entries));
    return entries;
  },

  async record(
    command: string,
    sessionKind: SessionKind,
    hostLabel: string,
  ): Promise<HistoryEntry | null> {
    const trimmed = command.trim();
    if (!trimmed) return null;

    let saved: HistoryEntry | null;
    if (isTauriRuntime()) {
      saved = await invokeTauri<HistoryEntry | null>('history_record', {
        command: trimmed,
        sessionKind,
        hostLabel,
      });
    } else {
      const list = readLs<HistoryEntry[]>(LS_HISTORY, () => []);
      const existing = list.find((e) => e.command === trimmed);
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
    }
    await this.load();
    return saved;
  },

  async remove(id: string): Promise<void> {
    if (isTauriRuntime()) {
      await invokeTauri<void>('history_delete', { id });
    } else {
      const list = readLs<HistoryEntry[]>(LS_HISTORY, () => []).filter((e) => e.id !== id);
      writeLs(LS_HISTORY, list);
    }
    await this.load();
  },

  async clear(): Promise<void> {
    if (isTauriRuntime()) {
      await invokeTauri<void>('history_clear');
    } else {
      writeLs(LS_HISTORY, []);
    }
    useHistoryPluginStore.setState({ history: [] });
    changeListeners.forEach((cb) => cb([]));
  },
};
