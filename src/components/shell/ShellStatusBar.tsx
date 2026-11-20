import React from 'react';
import { Layers, Puzzle, Server, Terminal } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { usePluginStatuses, useSlotItems } from '../../harness/HarnessContext';
import { useLayoutStore } from '../../layout/layoutStore';
import { getThemePreset } from '../../themes/presets';

export const ShellStatusBar: React.FC = () => {
  const activeSessionId = useShellStore((s) => s.activeSessionId);
  const activeSession = useShellStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : undefined,
  );
  const sessionCount = useShellStore((s) => s.sessionOrder.length);
  const sessionStatuses = useShellStore((s) => s.sessionStatuses);
  const settings = useShellStore((s) => s.settings);
  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeWorkspaceId = useLayoutStore((s) => s.activeWorkspaceId);
  const activeWorkspaceName =
    workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'Workspace 1';

  const leftSlots = useSlotItems('statusbar:left');
  const rightSlots = useSlotItems('statusbar:right');
  const pluginStatuses = usePluginStatuses();

  const status = activeSession
    ? sessionStatuses[activeSession.info.id] ?? activeSession.info.status
    : 'disconnected';
  const theme = getThemePreset(settings.themeId);
  const activePluginsCount = pluginStatuses.filter((p) => p.active).length;

  return (
    <footer
      className="h-6 px-3 shrink-0 flex items-center justify-between text-[11px] border-t select-none"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1 text-[var(--text-muted)] pr-2 border-r border-[var(--border-subtle)] shrink-0">
          <Layers className="w-3 h-3 text-[var(--accent)]" />
          <span className="truncate max-w-[120px]">{activeWorkspaceName}</span>
        </div>

        <div className="flex items-center gap-1.5 text-[var(--text-primary)]">
          {activeSession?.info.kind === 'ssh' ? (
            <Server className="w-3 h-3 text-[var(--accent)]" />
          ) : (
            <Terminal className="w-3 h-3 text-[var(--success)]" />
          )}
          <span className="truncate">{activeSession?.info.title ?? 'No Active Shell'}</span>
          <span className="text-[var(--text-muted)]">({status})</span>
          <span className="text-[var(--text-muted)] hidden md:inline">· {sessionCount} shells</span>
        </div>

        {leftSlots.map((slot) => (
          <React.Fragment key={`${slot.pluginId}:${slot.id}`}>{slot.render()}</React.Fragment>
        ))}
      </div>

      <div className="flex items-center gap-3 shrink-0 text-[var(--text-muted)]">
        {rightSlots.map((slot) => (
          <React.Fragment key={`${slot.pluginId}:${slot.id}`}>{slot.render()}</React.Fragment>
        ))}

        <button
          type="button"
          onClick={() => shellService.setPluginManagerOpen(true)}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <Puzzle className="w-3 h-3 text-[var(--accent)]" />
          <span>
            {activePluginsCount}/{pluginStatuses.length} Plugins
          </span>
        </button>

        <button
          type="button"
          onClick={() => shellService.setSettingsModalOpen(true)}
          className="hover:text-[var(--text-primary)]"
        >
          {theme.name}
        </button>
      </div>
    </footer>
  );
};
