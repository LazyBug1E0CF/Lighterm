import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  BookmarkCheck,
  Command,
  Layers,
  LayoutGrid,
  Pencil,
  Plus,
  Puzzle,
  Settings,
  X,
} from 'lucide-react';
import { shellService } from '../../core/shellService';
import { useWindowStore, windowControls } from '../../core/windowControls';
import { workspaceManager } from '../../core/workspaceManager';
import { usePluginStatuses, useSlotItems } from '../../kernel/KernelContext';
import { collectGroups } from '../../layout/dockTree';
import { layoutService, useLayoutStore } from '../../layout/layoutStore';
import type { WorkspaceState } from '../../layout/types';
import { TERMINAL_VIEWPORT_TYPE } from '../../plugins/terminal/terminalService';
import { WindowControls } from './WindowControls';

export const SLOW_RENAME_MIN_DELAY_MS = 300;
export const SLOW_RENAME_MAX_DELAY_MS = 2500;

const NON_DRAG_SELECTOR =
  'button, input, textarea, select, a, form, [role="tab"], [data-no-window-drag="true"]';

export const ShellTopBar: React.FC = () => {
  const workspaces = useLayoutStore((s) => s.workspaces);
  const activeWorkspaceId = useLayoutStore((s) => s.activeWorkspaceId);
  const viewports = useLayoutStore((s) => s.viewports);
  const platform = useWindowStore((s) => s.platform);
  const topbarSlots = useSlotItems('topbar:right');
  const pluginStatuses = usePluginStatuses();
  const activePluginsCount = pluginStatuses.filter((p) => p.active).length;

  const [quickInput, setQuickInput] = useState('');
  const [editingWsId, setEditingWsId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<{
    wsId: string;
    x: number;
    y: number;
  } | null>(null);

  const lastTabClickRef = useRef<{ wsId: string; at: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingWsId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingWsId]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    const handleBlur = () => setContextMenu(null);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleBlur);
    };
  }, [contextMenu]);

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
      void workspaceManager.renameLiveWorkspace(editingWsId, editingName);
    }
    setEditingWsId(null);
    setEditingName('');
  };

  const startRenaming = (ws: WorkspaceState) => {
    setContextMenu(null);
    lastTabClickRef.current = null;
    setEditingWsId(ws.id);
    setEditingName(ws.name);
  };

  const handleWorkspaceTabClick = (
    e: React.MouseEvent<HTMLDivElement>,
    ws: WorkspaceState,
  ) => {
    if (editingWsId === ws.id) return;
    setContextMenu(null);

    if (e.detail > 1) {
      lastTabClickRef.current = null;
      layoutService.selectWorkspace(ws.id);
      return;
    }

    const now = Date.now();
    const prev = lastTabClickRef.current;
    if (prev && prev.wsId === ws.id) {
      const elapsed = now - prev.at;
      if (elapsed < SLOW_RENAME_MIN_DELAY_MS) {
        lastTabClickRef.current = null;
        layoutService.selectWorkspace(ws.id);
        return;
      }
      if (elapsed <= SLOW_RENAME_MAX_DELAY_MS) {
        lastTabClickRef.current = null;
        layoutService.selectWorkspace(ws.id);
        startRenaming(ws);
        return;
      }
    }

    lastTabClickRef.current = { wsId: ws.id, at: now };
    layoutService.selectWorkspace(ws.id);
  };

  const contextWorkspace = contextMenu
    ? workspaces.find((w) => w.id === contextMenu.wsId) ?? null
    : null;

  const handleHeaderMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target instanceof Element && target.closest(NON_DRAG_SELECTOR)) return;
    if (e.detail === 2) {
      void windowControls.toggleMaximize();
    } else if (e.detail === 1) {
      windowControls.startDragging();
    }
  };

  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleHeaderMouseDown}
      className={`h-10 shrink-0 flex items-center gap-2 border-b select-none ${
        platform === 'windows' ? 'pl-3 pr-0' : 'px-3'
      }`}
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {platform === 'macos' && <WindowControls />}

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
          const isSaved = Boolean(ws.savedWorkspaceId);
          const shellCount = shellCountByWs[ws.id] ?? 0;

          return (
            <div
              key={ws.id}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
              onClick={(e) => handleWorkspaceTabClick(e, ws)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                lastTabClickRef.current = null;
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const menuWidth = 184;
                const x =
                  typeof window !== 'undefined'
                    ? Math.min(e.clientX, Math.max(8, window.innerWidth - menuWidth - 8))
                    : e.clientX;
                setContextMenu({ wsId: ws.id, x, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  layoutService.selectWorkspace(ws.id);
                }
              }}
              title="Click to switch workspace · Click twice or right-click to rename"
              className={`group flex items-center gap-1 h-7 px-2.5 rounded-md text-xs shrink-0 max-w-[240px] border cursor-pointer transition-colors ${
                isActive
                  ? 'border-[var(--accent)]/50 bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium'
                  : 'border-transparent hover:bg-[var(--bg-elevated)]/60 text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Layers className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              {isEditing ? (
                <input
                  ref={renameInputRef}
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

              {!isEditing && (
                <>
                  <button
                    type="button"
                    aria-label={`Rename ${ws.name}`}
                    title="Rename Workspace"
                    onClick={(e) => {
                      e.stopPropagation();
                      startRenaming(ws);
                    }}
                    className="hidden group-hover:inline-flex items-center justify-center p-0.5 rounded opacity-75 hover:opacity-100 hover:bg-white/10 hover:text-[var(--text-primary)] shrink-0"
                  >
                    <Pencil className="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Save ${ws.name}`}
                    title={isSaved ? 'Update Saved Workspace' : 'Save Workspace'}
                    onClick={(e) => {
                      e.stopPropagation();
                      void workspaceManager.saveWorkspace(ws.id);
                    }}
                    className={`hidden group-hover:inline-flex items-center justify-center p-0.5 rounded hover:bg-white/10 shrink-0 ${
                      isSaved
                        ? 'text-[var(--accent)] opacity-100'
                        : 'opacity-75 hover:opacity-100 hover:text-[var(--accent)]'
                    }`}
                  >
                    {isSaved ? (
                      <BookmarkCheck className="w-3 h-3" />
                    ) : (
                      <Bookmark className="w-3 h-3" />
                    )}
                  </button>
                </>
              )}

              {(workspaces.length > 1 || isSaved) && (
                <button
                  type="button"
                  aria-label={`Close ${ws.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    layoutService.closeWorkspace(ws.id);
                  }}
                  className="p-0.5 rounded opacity-50 group-hover:opacity-100 hover:bg-white/10 hover:text-[var(--danger)] shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}

        {contextMenu && contextWorkspace && (
          <div
            ref={contextMenuRef}
            role="menu"
            aria-label="Workspace Tab Context Menu"
            data-no-window-drag="true"
            style={{
              left: contextMenu.x,
              top: contextMenu.y,
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
            className="fixed z-50 w-44 py-1 rounded-lg border shadow-xl text-xs"
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                startRenaming(contextWorkspace);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              <Pencil className="w-3.5 h-3.5" /> Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setContextMenu(null);
                void workspaceManager.saveWorkspace(contextWorkspace.id);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              {contextWorkspace.savedWorkspaceId ? (
                <>
                  <BookmarkCheck className="w-3.5 h-3.5 text-[var(--accent)]" /> Update Saved Workspace
                </>
              ) : (
                <>
                  <Bookmark className="w-3.5 h-3.5" /> Save Workspace
                </>
              )}
            </button>
            {(workspaces.length > 1 || Boolean(contextWorkspace.savedWorkspaceId)) && (
              <>
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextMenu(null);
                    layoutService.closeWorkspace(contextWorkspace.id);
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--danger)] hover:bg-[var(--accent)]/20"
                >
                  <X className="w-3.5 h-3.5" /> Close Workspace
                </button>
              </>
            )}
          </div>
        )}

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

      {/* Dynamic Plugin Topbar Slot + Core Kernel Controls */}
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

      {platform !== 'macos' && <WindowControls />}
    </header>
  );
};
