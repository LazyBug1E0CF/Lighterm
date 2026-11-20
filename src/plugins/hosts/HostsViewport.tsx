import React, { useMemo, useState } from 'react';
import { Pencil, Play, Plus, Search, Server, Trash2 } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { useSlotItems } from '../../harness/HarnessContext';
import type { ViewportComponentProps } from '../../harness/types';
import type { HostConfig } from '../../types';

export const HostsViewport: React.FC<ViewportComponentProps> = () => {
  const hosts = useShellStore((s) => s.hosts);
  const hostActionSlots = useSlotItems('host:actions');

  const [query, setQuery] = useState('');

  const groupedHosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? hosts.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.host.toLowerCase().includes(q) ||
            h.username.toLowerCase().includes(q) ||
            h.group.toLowerCase().includes(q),
        )
      : hosts;

    const groups = new Map<string, HostConfig[]>();
    for (const host of filtered) {
      const groupName = host.group.trim() || 'Default';
      const list = groups.get(groupName) ?? [];
      list.push(host);
      groups.set(groupName, list);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [hosts, query]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-2.5 flex items-center gap-1.5 border-b border-[var(--border-subtle)] shrink-0">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter hosts..."
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => shellService.openHostModal(null)}
          title="Add SSH Host (Ctrl+Shift+N)"
          aria-label="New SSH Host"
          className="h-7 px-2 rounded-md text-xs font-medium flex items-center gap-1 bg-[var(--accent)] text-[#0f111a] hover:opacity-90 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Add</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto lighterm-scroll p-2 space-y-3">
        {groupedHosts.length === 0 ? (
          <div className="text-center py-8 px-3">
            <Server className="w-8 h-8 mx-auto mb-2 text-[var(--text-muted)] opacity-50" />
            <p className="text-xs text-[var(--text-muted)] mb-3">
              {hosts.length === 0 ? 'No saved SSH hosts yet.' : 'No hosts match your filter.'}
            </p>
            {hosts.length === 0 && (
              <button
                type="button"
                onClick={() => shellService.openHostModal(null)}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[var(--bg-elevated)] text-[var(--accent)] border border-[var(--accent)]/40 hover:bg-[var(--accent)]/15"
              >
                Create First Host
              </button>
            )}
          </div>
        ) : (
          groupedHosts.map(([groupName, groupItems]) => (
            <div key={groupName}>
              <div className="px-1.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {groupName} ({groupItems.length})
              </div>
              <div className="space-y-1">
                {groupItems.map((host) => (
                  <div
                    key={host.id}
                    onDoubleClick={() =>
                      void shellService.createSshSession({ hostId: host.id, hostConfig: host })
                    }
                    className="group p-2 rounded-md border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]/70 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: host.color || 'var(--accent)' }}
                        />
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {host.name || `${host.username}@${host.host}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void shellService.createSshSession({ hostId: host.id, hostConfig: host })
                        }
                        title="Connect in New Terminal"
                        aria-label={`Connect ${host.name}`}
                        className="p-1 rounded text-[var(--accent)] hover:bg-[var(--accent)]/15 opacity-80 group-hover:opacity-100"
                      >
                        <Play className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="mt-0.5 pl-4 text-[11px] text-[var(--text-muted)] truncate font-mono">
                      {host.username}@{host.host}:{host.port}
                    </div>

                    <div className="mt-1.5 pl-4 hidden group-hover:flex items-center gap-1 flex-wrap">
                      {hostActionSlots.map((slot) => (
                        <React.Fragment key={slot.id}>{slot.render({ host })}</React.Fragment>
                      ))}
                      <button
                        type="button"
                        onClick={() => shellService.openHostModal(host)}
                        title="Edit Host"
                        aria-label={`Edit ${host.name}`}
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-app)]"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void shellService.deleteHost(host.id)}
                        title="Delete Host"
                        aria-label={`Delete ${host.name}`}
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-app)]"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
