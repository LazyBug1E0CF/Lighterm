import React, { useEffect, useMemo, useState } from 'react';
import { Code2, History, Search, Server, Terminal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

interface PaletteItem {
  id: string;
  group: 'Action' | 'SSH Host' | 'Snippet' | 'History';
  label: string;
  subtitle?: string;
  run: () => Promise<void> | void;
}

export const CommandPaletteModal: React.FC = () => {
  const open = useAppStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const hosts = useAppStore((s) => s.hosts);
  const snippets = useAppStore((s) => s.snippets);
  const history = useAppStore((s) => s.history);
  const openLocalTab = useAppStore((s) => s.openLocalTab);
  const openHostModal = useAppStore((s) => s.openHostModal);
  const openSshTab = useAppStore((s) => s.openSshTab);
  const splitActivePane = useAppStore((s) => s.splitActivePane);
  const toggleSftpDrawer = useAppStore((s) => s.toggleSftpDrawer);
  const toggleMonitorPanel = useAppStore((s) => s.toggleMonitorPanel);
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen);
  const sendTextToActivePane = useAppStore((s) => s.sendTextToActivePane);

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: 'act-local',
        group: 'Action',
        label: 'New Local Terminal Tab',
        run: () => openLocalTab(),
      },
      {
        id: 'act-new-host',
        group: 'Action',
        label: 'Add New SSH Host',
        run: () => openHostModal(null),
      },
      {
        id: 'act-split-h',
        group: 'Action',
        label: 'Split Active Pane Horizontally',
        run: () => splitActivePane('horizontal'),
      },
      {
        id: 'act-split-v',
        group: 'Action',
        label: 'Split Active Pane Vertically',
        run: () => splitActivePane('vertical'),
      },
      {
        id: 'act-sftp',
        group: 'Action',
        label: 'Toggle SFTP File Browser',
        run: () => toggleSftpDrawer(),
      },
      {
        id: 'act-monitor',
        group: 'Action',
        label: 'Toggle System Status Panel',
        run: () => toggleMonitorPanel(),
      },
      {
        id: 'act-settings',
        group: 'Action',
        label: 'Open Settings',
        run: () => setSettingsModalOpen(true),
      },
    ];

    const hostItems: PaletteItem[] = hosts.map((h) => ({
      id: `host-${h.id}`,
      group: 'SSH Host',
      label: `Connect: ${h.name || h.host}`,
      subtitle: `${h.username}@${h.host}:${h.port}`,
      run: () => openSshTab(h),
    }));

    const snippetItems: PaletteItem[] = snippets.map((s) => ({
      id: `snip-${s.id}`,
      group: 'Snippet',
      label: s.title,
      subtitle: s.command,
      run: () => sendTextToActivePane(s.command, s.autoExecute),
    }));

    const historyItems: PaletteItem[] = history.slice(0, 20).map((h) => ({
      id: `hist-${h.id}`,
      group: 'History',
      label: h.command,
      subtitle: h.hostLabel,
      run: () => sendTextToActivePane(h.command, true),
    }));

    const all = [...actions, ...hostItems, ...snippetItems, ...historyItems];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 30);
    return all
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.subtitle?.toLowerCase().includes(q) ?? false) ||
          item.group.toLowerCase().includes(q),
      )
      .slice(0, 30);
  }, [
    hosts,
    snippets,
    history,
    query,
    openLocalTab,
    openHostModal,
    splitActivePane,
    toggleSftpDrawer,
    toggleMonitorPanel,
    setSettingsModalOpen,
    openSshTab,
    sendTextToActivePane,
  ]);

  if (!open) return null;

  const executeItem = async (item?: PaletteItem) => {
    if (!item) return;
    setCommandPaletteOpen(false);
    await item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50 backdrop-blur-xs p-4"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Command Palette"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl rounded-xl border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-3 py-2.5 flex items-center gap-2 border-b border-[var(--border-subtle)]">
          <Search className="w-4 h-4 text-[var(--accent)]" />
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
                void executeItem(items[selectedIdx]);
              } else if (e.key === 'Escape') {
                setCommandPaletteOpen(false);
              }
            }}
            placeholder="Search actions, SSH hosts, snippets, or command history..."
            className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
        </div>

        <div className="max-h-80 overflow-y-auto lighterm-scroll p-1.5 space-y-0.5 text-xs">
          {items.length === 0 ? (
            <div className="py-6 text-center text-[var(--text-muted)]">No matches found</div>
          ) : (
            items.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => void executeItem(item)}
                className={`w-full px-2.5 py-2 rounded-md flex items-center justify-between gap-2 text-left ${
                  idx === selectedIdx
                    ? 'bg-[var(--accent)]/20 text-[var(--text-primary)]'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {item.group === 'SSH Host' ? (
                    <Server className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  ) : item.group === 'Snippet' ? (
                    <Code2 className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                  ) : item.group === 'History' ? (
                    <History className="w-3.5 h-3.5 text-[var(--warning)] shrink-0" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
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
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] shrink-0">
                  {item.group}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
