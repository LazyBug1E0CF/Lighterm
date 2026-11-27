import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Plus, Search, Server, Terminal } from 'lucide-react';
import { isWebRuntime } from '../../core/ipc';
import {
  formatRelativeTime,
  getEffectiveLocalShells,
  orderLocalShellsByDefault,
  parseQuickSshInput,
  resolveEffectiveDefaultLocalShell,
  resolveRecentHostEntry,
  shellService,
  useShellStore,
} from '../../core/shellService';
import { useWebAuthStore } from '../../core/webTransport';

type HostPaletteSection = 'Recent Hosts' | 'Saved Hosts' | 'Local Terminals' | 'Quick Connect';

interface HostPaletteItem {
  id: string;
  section: HostPaletteSection;
  label: string;
  subtitle?: string;
  badge?: string;
  color?: string | null;
  searchText: string;
  run: () => Promise<void> | void;
}

export const HostPaletteModal: React.FC = () => {
  const open = useShellStore((s) => s.hostPaletteOpen);
  const hosts = useShellStore((s) => s.hosts);
  const recentHosts = useShellStore((s) => s.recentHosts);
  const localShells = useShellStore((s) => s.localShells);
  const localShellsLoaded = useShellStore((s) => s.localShellsLoaded);
  const settings = useShellStore((s) => s.settings);
  const webLocalShellEnabled = useWebAuthStore((s) => s.localShellEnabled);
  const localShellAllowed = !isWebRuntime() || webLocalShellEnabled;

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIdx(0);
    if (localShellAllowed && !localShellsLoaded) {
      void shellService.listLocalShells();
    }
  }, [open, localShellAllowed, localShellsLoaded]);

  const items = useMemo<HostPaletteItem[]>(() => {
    const q = query.trim().toLowerCase();

    const recentItems: HostPaletteItem[] = recentHosts.map((raw) => {
      const { entry } = resolveRecentHostEntry(raw, hosts);
      return {
        id: `recent-${entry.key}`,
        section: 'Recent Hosts',
        label: entry.name,
        subtitle: `${entry.username}@${entry.host}:${entry.port}`,
        badge: formatRelativeTime(entry.lastConnectedAt),
        color: entry.color,
        searchText: `${entry.name} ${entry.username}@${entry.host}:${entry.port} ${entry.group ?? ''}`,
        run: async () => {
          await shellService.connectRecentHost(entry);
        },
      };
    });

    const hostItems: HostPaletteItem[] = hosts.map((host) => ({
      id: `saved-host-${host.id}`,
      section: 'Saved Hosts',
      label: host.name || `${host.username}@${host.host}`,
      subtitle: `${host.username}@${host.host}:${host.port}`,
      badge: host.group || 'SSH',
      color: host.color,
      searchText: `${host.name} ${host.username}@${host.host}:${host.port} ${host.group}`,
      run: async () => {
        await shellService.createSshSession({ hostId: host.id, hostConfig: host });
      },
    }));

    const effectiveShells = localShellAllowed ? getEffectiveLocalShells(localShells) : [];
    const effectiveDefault = resolveEffectiveDefaultLocalShell(settings, effectiveShells);
    const orderedShells = orderLocalShellsByDefault(effectiveShells, effectiveDefault);
    const localItems: HostPaletteItem[] = localShellAllowed
      ? orderedShells.map(({ profile, isDefault }) => ({
          id: `local-shell-${profile.id}`,
          section: 'Local Terminals',
          label: profile.name,
          subtitle: profile.description
            ? `${profile.description} · ${profile.shell}`
            : profile.shell,
          badge: isDefault ? 'Default' : 'Local',
          searchText: `${profile.name} ${profile.shell} ${profile.description ?? ''} local terminal`,
          run: async () => {
            await shellService.createLocalSession({
              shell: profile.shell,
              title: profile.name,
            });
          },
        }))
      : [];

    const quickItems: HostPaletteItem[] = [];
    const parsedQuick = parseQuickSshInput(query);
    if (parsedQuick) {
      quickItems.push({
        id: 'quick-connect',
        section: 'Quick Connect',
        label: `Connect: ${parsedQuick.username}@${parsedQuick.host}:${parsedQuick.port}`,
        subtitle: 'Quick SSH Connection',
        badge: 'SSH',
        searchText: query,
        run: async () => {
          await shellService.quickConnectSsh(query);
        },
      });
    }

    const all = [...recentItems, ...hostItems, ...localItems, ...quickItems];
    if (!q) return all;
    return all.filter(
      (item) =>
        item.searchText.toLowerCase().includes(q) ||
        item.section.toLowerCase().includes(q),
    );
  }, [recentHosts, hosts, localShells, settings, localShellAllowed, query]);

  const sections = useMemo(() => {
    const order: HostPaletteSection[] = [
      'Recent Hosts',
      'Saved Hosts',
      'Local Terminals',
      'Quick Connect',
    ];
    const groups: { title: HostPaletteSection; items: { item: HostPaletteItem; flatIdx: number }[] }[] = [];
    let flatIdx = 0;
    for (const sec of order) {
      const matched = items.filter((it) => it.section === sec);
      if (matched.length === 0) continue;
      groups.push({
        title: sec,
        items: matched.map((item) => ({ item, flatIdx: flatIdx++ })),
      });
    }
    return groups;
  }, [items]);

  if (!open) return null;

  const clampedIdx = items.length > 0 ? Math.min(selectedIdx, items.length - 1) : 0;

  const executeItem = async (item?: HostPaletteItem) => {
    if (!item) return;
    shellService.setHostPaletteOpen(false);
    await item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50 backdrop-blur-xs p-4"
      onClick={() => shellService.setHostPaletteOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Host Palette"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-xl border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-3 py-2.5 flex items-center gap-2 border-b border-[var(--border-subtle)]">
          <Search className="w-4 h-4 text-[var(--accent)] shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                void executeItem(items[clampedIdx]);
              } else if (e.key === 'Escape') {
                shellService.setHostPaletteOpen(false);
              }
            }}
            placeholder={
              localShellAllowed
                ? 'Search recent hosts, saved hosts, local terminals, or user@host[:port]...'
                : 'Search recent hosts, saved hosts, or user@host[:port]...'
            }
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
        </div>

        <div className="max-h-96 overflow-y-auto lighterm-scroll p-1.5 space-y-2 text-xs">
          {items.length === 0 ? (
            <div className="py-6 text-center text-[var(--text-muted)]">
              {localShellAllowed ? 'No matching hosts or local terminals' : 'No matching hosts'}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.title}>
                <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {section.title}
                </div>
                <div className="space-y-0.5">
                  {section.items.map(({ item, flatIdx }) => (
                    <button
                      key={item.id}
                      type="button"
                      onMouseEnter={() => setSelectedIdx(flatIdx)}
                      onClick={() => void executeItem(item)}
                      className={`w-full px-2.5 py-2 rounded-md flex items-center justify-between gap-2 text-left ${
                        flatIdx === clampedIdx
                          ? 'bg-[var(--accent)]/20 text-[var(--text-primary)]'
                          : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {item.section === 'Recent Hosts' ? (
                          <Clock className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                        ) : item.section === 'Saved Hosts' || item.section === 'Quick Connect' ? (
                          <Server className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                        ) : (
                          <Terminal className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                        )}
                        {item.color && (
                          <span
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: item.color }}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium">{item.label}</div>
                          {item.subtitle && (
                            <div className="truncate text-[11px] font-mono text-[var(--text-muted)]">
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                      {item.badge && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] shrink-0">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div
          className="px-3 py-2 border-t border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)]"
          style={{ backgroundColor: 'var(--bg-elevated)' }}
        >
          <span>↑↓ Navigate · Enter Connect · Esc Close</span>
          <button
            type="button"
            onClick={() => {
              shellService.setHostPaletteOpen(false);
              shellService.openHostModal(null);
            }}
            className="text-[var(--accent)] hover:underline flex items-center gap-1"
          >
            <Plus className="w-3 h-3" />
            New SSH Host
          </button>
        </div>
      </div>
    </div>
  );
};
