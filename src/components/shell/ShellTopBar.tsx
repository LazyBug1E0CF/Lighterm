import React, { useState } from 'react';
import {
  Command,
  LayoutGrid,
  Plus,
  Puzzle,
  Server,
  Settings,
  Terminal,
} from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { usePluginStatuses, useSlotItems } from '../../harness/HarnessContext';
import { layoutService, useLayoutStore } from '../../layout/layoutStore';
import { TERMINAL_VIEWPORT_TYPE } from '../../plugins/terminal/terminalService';

export const ShellTopBar: React.FC = () => {
  const sessionOrder = useShellStore((s) => s.sessionOrder);
  const sessions = useShellStore((s) => s.sessions);
  const activeSessionId = useShellStore((s) => s.activeSessionId);
  const sessionStatuses = useShellStore((s) => s.sessionStatuses);
  const topbarSlots = useSlotItems('topbar:right');
  const pluginStatuses = usePluginStatuses();
  const activePluginsCount = pluginStatuses.filter((p) => p.active).length;

  const [quickInput, setQuickInput] = useState('');

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    await shellService.quickConnectSsh(quickInput);
    setQuickInput('');
  };

  const focusSession = (sessionId: string) => {
    shellService.setActiveSession(sessionId);
    const viewports = useLayoutStore.getState().viewports;
    const matched = Object.values(viewports).find(
      (vp) => vp.typeId === TERMINAL_VIEWPORT_TYPE && String(vp.params?.sessionId ?? '') === sessionId,
    );
    if (matched) {
      layoutService.setActiveViewport(matched.id);
    }
  };

  return (
    <header
      className="h-11 shrink-0 flex items-center gap-2 px-3 border-b select-none"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Brand Badge */}
      <div className="flex items-center gap-2 pr-2 border-r border-[var(--border-subtle)] shrink-0">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center font-mono text-xs font-bold"
          style={{ backgroundColor: 'var(--accent)', color: '#0f111a' }}
        >
          &gt;_
        </div>
        <span className="text-xs font-semibold tracking-wide text-[var(--text-primary)] hidden sm:inline">
          Lighterm
        </span>
      </div>

      {/* Core Shell Session Strip */}
      <div className="flex-1 flex items-center gap-1 overflow-x-auto lighterm-scroll min-w-0">
        {sessionOrder.map((sid) => {
          const rec = sessions[sid];
          if (!rec) return null;
          const isActive = sid === activeSessionId;
          const status = sessionStatuses[sid] ?? rec.info.status;
          const dotColor =
            status === 'connected'
              ? 'var(--success)'
              : status === 'connecting'
                ? 'var(--warning)'
                : status === 'error'
                  ? 'var(--danger)'
                  : 'var(--text-muted)';

          return (
            <button
              key={sid}
              type="button"
              onClick={() => focusSession(sid)}
              className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs shrink-0 max-w-[170px] border transition-colors ${
                isActive
                  ? 'border-[var(--accent)]/50 bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium'
                  : 'border-transparent hover:bg-[var(--bg-elevated)]/60 text-[var(--text-muted)]'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: dotColor }}
              />
              {rec.info.kind === 'ssh' ? (
                <Server className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              ) : (
                <Terminal className="w-3 h-3 shrink-0 opacity-75" />
              )}
              <span className="truncate">{rec.info.title}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => void shellService.createLocalSession()}
          title="New Local Terminal (Ctrl+Shift+T)"
          aria-label="New Local Terminal"
          className="h-7 px-2 rounded-md flex items-center gap-1 shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden xl:inline">Shell</span>
        </button>
      </div>

      {/* Core Quick SSH Connect */}
      <form onSubmit={handleQuickSubmit} className="hidden md:flex items-center shrink-0">
        <input
          type="text"
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          placeholder="ssh user@host[:port]"
          aria-label="Quick SSH Connect"
          className="w-44 lg:w-52 h-7 px-2.5 text-xs rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
        />
      </form>

      {/* Dynamic Plugin Topbar Slot + Core Harness Controls */}
      <div className="flex items-center gap-1 shrink-0 pl-1 border-l border-[var(--border-subtle)]">
        {topbarSlots.map((slot) => (
          <React.Fragment key={`${slot.pluginId}:${slot.id}`}>{slot.render()}</React.Fragment>
        ))}

        <button
          type="button"
          onClick={() => layoutService.resetLayoutPreservingViewports()}
          title="Reset Docked Layout"
          aria-label="Reset Layout"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={() => shellService.setPluginManagerOpen(true)}
          title="Plugin Manager (Ctrl+Shift+X)"
          aria-label="Manage Plugins"
          className="h-7 px-2 rounded-md flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Puzzle className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span className="hidden xl:inline">Plugins ({activePluginsCount})</span>
        </button>

        <button
          type="button"
          onClick={() => shellService.setCommandPaletteOpen(true)}
          title="Command Palette (Ctrl+Shift+P)"
          aria-label="Command Palette"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Command className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={() => shellService.setSettingsModalOpen(true)}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
