import React, { useEffect, useMemo, useState } from 'react';
import { CornerDownLeft, History, Play, Search, Trash2 } from 'lucide-react';
import { shellService } from '../../core/shellService';
import { usePluginConfig } from '../../harness';
import type { ViewportComponentProps } from '../../harness/types';
import {
  DEFAULT_HISTORY_CONFIG,
  historyClient,
  useHistoryPluginStore,
} from './historyClient';

export const HistoryViewport: React.FC<ViewportComponentProps> = () => {
  const history = useHistoryPluginStore((s) => s.history);
  const { config: historyConfig } = usePluginConfig('lighterm.history', DEFAULT_HISTORY_CONFIG);
  const [query, setQuery] = useState('');

  const rawMax = Number(historyConfig.maxDisplayEntries);
  const maxEntries = Number.isFinite(rawMax)
    ? Math.max(10, rawMax)
    : DEFAULT_HISTORY_CONFIG.maxDisplayEntries;

  useEffect(() => {
    void historyClient.load(undefined, maxEntries);
  }, [maxEntries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? history.filter(
          (h) => h.command.toLowerCase().includes(q) || h.hostLabel.toLowerCase().includes(q),
        )
      : history;
    return list.slice(0, maxEntries);
  }, [history, query, maxEntries]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-2.5 flex items-center gap-1.5 border-b border-[var(--border-subtle)] shrink-0">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search history..."
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
          />
        </div>
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => void historyClient.clear()}
            title="Clear History"
            aria-label="Clear History"
            className="h-7 px-2 rounded-md text-xs text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-elevated)] shrink-0"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto lighterm-scroll p-2 space-y-1.5">
        {filtered.length === 0 ? (
          <div className="text-center py-8 px-3">
            <History className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-50" />
            <p className="text-xs text-[var(--text-muted)]">
              {history.length === 0
                ? 'Commands executed in terminal sessions appear here.'
                : 'No matching history entries.'}
            </p>
          </div>
        ) : (
          filtered.map((item) => (
            <div
              key={item.id}
              className="group p-2 rounded-md border border-[var(--border-subtle)]/50 bg-[var(--bg-app)]/50 hover:border-[var(--accent)]/40"
            >
              <div className="font-mono text-xs text-[var(--text-primary)] break-all">
                {item.command}
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                <div className="flex items-center gap-1.5 truncate">
                  <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
                    {item.hostLabel}
                  </span>
                  {item.count > 1 && <span>×{item.count}</span>}
                </div>
                <div className="flex items-center gap-1 opacity-70 group-hover:opacity-100 shrink-0">
                  <button
                    type="button"
                    onClick={() => void shellService.sendTextToActiveSession(item.command, true)}
                    title="Run Command"
                    className="p-1 rounded text-[var(--accent)] hover:bg-[var(--accent)]/15"
                  >
                    <Play className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void shellService.sendTextToActiveSession(item.command, false)}
                    title="Insert Command"
                    className="p-1 rounded hover:text-[var(--text-primary)]"
                  >
                    <CornerDownLeft className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void historyClient.remove(item.id)}
                    title="Delete Entry"
                    className="p-1 rounded hover:text-[var(--danger)]"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
