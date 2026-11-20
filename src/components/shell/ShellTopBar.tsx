import React, { useMemo, useState } from 'react';
import {
  Command,
  Layers,
  LayoutGrid,
  Plus,
  Puzzle,
  Settings,
  X,
} from 'lucide-react';
import { shellService } from '../../core/shellService';
import { usePluginStatuses, useSlotItems } from '../../harness/HarnessContext';
import { collectGroups } from '../../layout/dockTree';
import { layoutService, useLayoutStore } from '../../layout/layoutStore';
import { TERMINAL_VIEWPORT_TYPE } from '../../plugins/terminal/terminalService';

export const ShellTopBar: React.FC = () => {
  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeWorkspaceId = useLayoutStore((s) => s.activeWorkspaceId);
  const viewports = useLayoutStore((s) => s.viewports);
  const topbarSlots = useSlotItems('topbar:right');
  const pluginStatuses = usePluginStatuses();
  const activePluginsCount = pluginStatuses.filter((p) => p.active).length;

  const [quickInput, setQuickInput] = useState('');
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const shellCountByWs = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ws of workspaces) {
      const ids = new Set<string>();
      for (const grp of collectGroups(ws.dockRoot)) {
        for (const vid of grp.viewportIds) ids.add(vid);
      }
      for (const item of ws.floating) {
        ids.add(item.viewportId);
      }
      let n = 0;
      for (const id of ids) {
        if (viewports[id]?.typeId === TERMINAL_VIEWPORT_TYPE) n += 1;
      }
      counts[ws.id] = n;
    }
    return counts;
  }, [workspaces, viewports]);

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    await shellService.quickConnectSsh(quickInput);
    setQuickInput('');
  };

  const handleNewWorkspace = () => {
    layoutService.createWorkspace();
    void shellService.createLocalSession();
  };

  const commitRename = () => {
    if (editingWsId && editingName.trim()) {
      layoutService.renameWorkspace(editingWsId, editingName);
    }
    setEditingWsId(null);
    setEditingName('');
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

      {/* Upper Workspace Group Tab Strip */}
      <div
        role="tablist"
        aria-label="Workspaces"
        className="flex-1 flex items-center gap-1 overflow-x-auto lighterm-scroll min-w-0"
      >
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const isEditing = editingWsId === ws.id;
          const shellCount = shellCountByWs[ws.id] ?? 0;

          return (
            <div
              key={ws.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={() => layoutService.selectWorkspace(ws.id)}
              onDoubleClick={() => {
                setEditingWsId(ws.id);
                setEditingName(ws.name);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  layoutService.selectWorkspace(ws.id);
                }
              }}
              title="Click to switch workspace · Double-click to rename"
              className={`group flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs shrink-0 max-w-[200px] border cursor-pointer transition-colors ${
                isActive
                  ? 'border-[var(--accent)]/50 bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium'
                  : 'border-transparent hover:bg-[var(--bg-elevated)]/60 text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Layers className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              {isEditing ? (
                <input
                  type="text"
                  autoFocus
                  aria-label="Rename Workspace"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') {
                      setEditingWsId(null);
                      setEditingName('');
                    }
                  }}
                  className="w-24 h-5 px-1 rounded bg-[var(--bg-app)] border border-[var(--accent)] text-xs text-[var(--text-primary)] outline-none"
                />
              ) : (
                <span className="truncate">{ws.name}</span>
              )}

              <span className="px-1 py-0 rounded text-[10px] font-mono bg-[var(--bg-app)]/80 text-[var(--text-muted)] shrink-0">
                {shellCount}
              </span>

              {workspaces.length > 1 && (
                <button
                  type="button"
                  aria-label={`Close ${ws.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    layoutService.closeWorkspace(ws.id);
                  }}
                  className="ml-0.5 p-0.5 rounded opacity-50 group-hover:opacity-100 hover:bg-white/10 hover:text-[var(--danger)]"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        <button
          type="button"
          onClick={handleNewWorkspace}
          title="New Workspace"
          aria-label="New Workspace"
          className="h-7 w-7 rounded-md flex items-center justify-center shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
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
