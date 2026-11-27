import React, { useEffect, useMemo, useState } from 'react';
import { Code2, History, Layers, Search, Server, Terminal } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { updateService } from '../../core/updateService';
import { workspaceManager } from '../../core/workspaceManager';
import { useCommands } from '../../kernel/KernelContext';
import { layoutService } from '../../layout/layoutStore';

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  subtitle?: string;
  run: () => Promise<void> | void;
}

export const CommandPaletteModal: React.FC = () => {
  const open = useShellStore((s) => s.commandPaletteOpen);
  const hosts = useShellStore((s) => s.hosts);
  const savedWorkspaces = useShellStore((s) => s.savedWorkspaces);
  const pluginCommands = useCommands();

  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
    }
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const coreActions: PaletteItem[] = [
      {
        id: 'core-local',
        group: 'Core',
        label: 'New Local Shell Connection',
        run: async () => {
          await shellService.createLocalSession();
        },
      },
      {
        id: 'core-host-palette',
        group: 'Core',
        label: 'Open Host Palette',
        subtitle: 'Recent hosts, saved hosts, and local terminals',
        run: () => shellService.setHostPaletteOpen(true),
      },
      {
        id: 'core-new-workspace',
        group: 'Core',
        label: 'New Workspace',
        run: () => {
          layoutService.createWorkspace();
        },
      },
      {
        id: 'core-save-workspace',
        group: 'Core',
        label: 'Save Current Workspace',
        run: async () => {
          await workspaceManager.saveWorkspace();
        },
      },
      {
        id: 'core-new-host',
        group: 'Core',
        label: 'Add New SSH Host',
        run: () => shellService.openHostModal(null),
      },
      {
        id: 'core-plugins',
        group: 'Core',
        label: 'Manage Plugins (Everything-is-a-Plugin)',
        run: () => shellService.setPluginManagerOpen(true),
      },
      {
        id: 'core-reset-layout',
        group: 'Core',
        label: 'Reset Workspace Docked Layout',
        run: () => layoutService.resetLayoutPreservingViewports(),
      },
      {
        id: 'core-auto-collapse-left',
        group: 'Core',
        label: 'Toggle Left Drawer Auto-Collapse',
        run: () => layoutService.toggleDrawerAutoCollapse('left'),
      },
      {
        id: 'core-auto-collapse-right',
        group: 'Core',
        label: 'Toggle Right Drawer Auto-Collapse',
        run: () => layoutService.toggleDrawerAutoCollapse('right'),
      },
      {
        id: 'core-settings',
        group: 'Core',
        label: 'Open Settings',
        run: () => shellService.setSettingsModalOpen(true),
      },
      {
        id: 'core-check-updates',
        group: 'Core',
        label: 'Check for Updates',
        run: async () => {
          const res = await updateService.checkForUpdates({ manual: true });
          if (res?.hasUpdate && !res.isSkipped) {
            updateService.openModal();
          } else {
            shellService.openSettings('updates');
          }
        },
      },
    ];

    const workspaceItems: PaletteItem[] = savedWorkspaces.map((ws) => ({
      id: `workspace-${ws.id}`,
      group: 'Workspace',
      label: `Open Workspace: ${ws.name}`,
      subtitle: `${ws.slots.length} terminals · ${(ws.layoutPreset ?? 'tab').toUpperCase()}`,
      run: async () => {
        await workspaceManager.openSavedWorkspace(ws.id);
      },
    }));

    const hostItems: PaletteItem[] = hosts.map((h) => ({
      id: `host-${h.id}`,
      group: 'SSH Host',
      label: `Connect: ${h.name || h.host}`,
      subtitle: `${h.username}@${h.host}:${h.port}`,
      run: async () => {
        await shellService.createSshSession({ hostId: h.id, hostConfig: h });
      },
    }));

    const dynamicItems: PaletteItem[] = pluginCommands.map((cmd) => ({
      id: `${cmd.pluginId}:${cmd.id}`,
      group: cmd.group,
      label: cmd.label,
      subtitle: cmd.subtitle,
      run: cmd.run,
    }));

    const all = [...coreActions, ...workspaceItems, ...hostItems, ...dynamicItems];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 32);
    return all
      .filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (item.subtitle?.toLowerCase().includes(q) ?? false) ||
          item.group.toLowerCase().includes(q),
      )
      .slice(0, 32);
  }, [hosts, savedWorkspaces, pluginCommands, query]);

  if (!open) return null;

  const executeItem = async (item?: PaletteItem) => {
    if (!item) return;
    shellService.setCommandPaletteOpen(false);
    await item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-20 bg-black/50 backdrop-blur-xs p-4"
      onClick={() => shellService.setCommandPaletteOpen(false)}
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
                shellService.setCommandPaletteOpen(false);
              }
            }}
            placeholder="Search core actions, plugin commands, SSH hosts, snippets, history..."
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
                  {item.group === 'Workspace' ? (
                    <Layers className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  ) : item.group === 'SSH Host' ? (
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
