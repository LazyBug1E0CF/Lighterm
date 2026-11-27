import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  Clock,
  Command,
  Layers,
  Play,
  Plus,
  Server,
  Settings,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  formatRelativeTime,
  getEffectiveLocalShells,
  orderLocalShellsByDefault,
  resolveEffectiveDefaultLocalShell,
  resolveRecentHostEntry,
  shellService,
  useShellStore,
} from '../core/shellService';
import { workspaceManager } from '../core/workspaceManager';
import { useLayoutStore } from './layoutStore';

interface WorkspaceEmptyViewProps {
  localShellAllowed: boolean;
}

export const WorkspaceEmptyView: React.FC<WorkspaceEmptyViewProps> = ({ localShellAllowed }) => {
  const hosts = useShellStore((s) => s.hosts);
  const savedWorkspaces = useShellStore((s) => s.savedWorkspaces);
  const recentHosts = useShellStore((s) => s.recentHosts);
  const settings = useShellStore((s) => s.settings);
  const localShells = useShellStore((s) => s.localShells);
  const localShellsLoaded = useShellStore((s) => s.localShellsLoaded);
  const workspaces = useLayoutStore((s) => s.workspaces);

  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const shellMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (localShellAllowed && !localShellsLoaded) {
      void shellService.listLocalShells();
    }
  }, [localShellAllowed, localShellsLoaded]);

  useEffect(() => {
    if (!shellMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (shellMenuRef.current?.contains(e.target as Node)) return;
      setShellMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShellMenuOpen(false);
    };
    const onBlur = () => setShellMenuOpen(false);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [shellMenuOpen]);

  const availableShells = useMemo(
    () => (localShellAllowed ? getEffectiveLocalShells(localShells) : []),
    [localShellAllowed, localShells],
  );
  const activeLocalShell = useMemo(
    () => resolveEffectiveDefaultLocalShell(settings, availableShells),
    [settings, availableShells],
  );
  const orderedShells = useMemo(
    () => orderLocalShellsByDefault(availableShells, activeLocalShell),
    [availableShells, activeLocalShell],
  );
  const hasMultipleLocalShells = orderedShells.length > 1;
  const localShellTitle = activeLocalShell.profile
    ? `Open Local Shell (${activeLocalShell.profile.name})`
    : activeLocalShell.shell
      ? `Open Local Shell (${activeLocalShell.shell})`
      : 'Open Local Shell';

  const openSavedIds = useMemo(
    () =>
      new Set(
        workspaces
          .map((ws) => ws.savedWorkspaceId)
          .filter((id): id is string => Boolean(id)),
      ),
    [workspaces],
  );

  const sortedSavedWorkspaces = useMemo(
    () => [...savedWorkspaces].sort((a, b) => b.updatedAt - a.updatedAt),
    [savedWorkspaces],
  );

  const resolvedRecentHosts = useMemo(
    () => recentHosts.map((entry) => resolveRecentHostEntry(entry, hosts)),
    [recentHosts, hosts],
  );

  return (
    <div className="flex-1 overflow-y-auto lighterm-scroll flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Left Column: New Local Shell + Saved Workspaces + Saved Hosts */}
        <section
          aria-label="Workspace Start Actions"
          className="rounded-xl border border-[var(--border-subtle)] p-4 flex flex-col gap-4 min-w-0"
          style={{ backgroundColor: 'var(--bg-surface)' }}
        >
          {localShellAllowed ? (
            <div className="flex items-center gap-2 flex-wrap">
              {hasMultipleLocalShells ? (
                <div
                  ref={shellMenuRef}
                  className="relative inline-flex items-stretch shrink-0 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/70 hover:border-[var(--accent)]/70 transition-colors"
                >
                  <button
                    type="button"
                    aria-label="Create First Local Shell"
                    title={localShellTitle}
                    onClick={() => {
                      setShellMenuOpen(false);
                      void shellService.createLocalSession();
                    }}
                    className="h-8 px-2.5 rounded-l-md text-xs text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/70 flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
                    Local Shell
                  </button>
                  <button
                    type="button"
                    aria-label="Select Local Shell"
                    aria-haspopup="menu"
                    aria-expanded={shellMenuOpen}
                    title="Choose Local Shell"
                    onClick={() => setShellMenuOpen((prev) => !prev)}
                    className={`h-8 px-1.5 rounded-r-md border-l border-[var(--border-subtle)] flex items-center justify-center transition-colors cursor-pointer ${
                      shellMenuOpen
                        ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/70'
                    }`}
                  >
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform duration-150 ${
                        shellMenuOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {shellMenuOpen && (
                    <div
                      role="menu"
                      aria-label="Local Shell Menu"
                      style={{
                        backgroundColor: 'var(--bg-elevated)',
                        borderColor: 'var(--border-subtle)',
                      }}
                      className="lighterm-pop-enter absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border shadow-2xl p-1.5 space-y-0.5 text-left"
                    >
                      <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                        Local Shells
                      </div>
                      {orderedShells.map(({ profile, isDefault }) => (
                        <button
                          key={profile.id}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setShellMenuOpen(false);
                            void shellService.createLocalSession({
                              shell: profile.shell,
                              title: profile.name,
                            });
                          }}
                          className="w-full px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 text-left hover:bg-[var(--bg-surface)] text-[var(--text-primary)] transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Terminal className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                            <div className="min-w-0">
                              <div className="text-xs font-medium truncate">{profile.name}</div>
                              <div className="text-[10px] font-mono text-[var(--text-muted)] truncate">
                                {profile.shell}
                              </div>
                            </div>
                          </div>
                          {isDefault && (
                            <span className="px-1.5 py-0 rounded text-[9px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] shrink-0">
                              Default
                            </span>
                          )}
                        </button>
                      ))}
                      <div className="my-1 border-t border-[var(--border-subtle)]" />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setShellMenuOpen(false);
                          shellService.openSettings('lighterm.terminal:terminal');
                        }}
                        className="w-full px-2.5 py-1.5 rounded-lg flex items-center gap-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface)] transition-colors cursor-pointer"
                      >
                        <Settings className="w-3 h-3 shrink-0" />
                        Configure Default Shell…
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  aria-label="Create First Local Shell"
                  title={localShellTitle}
                  onClick={() => void shellService.createLocalSession()}
                  className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/70 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] hover:bg-[var(--bg-elevated)]/70 flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
                  Local Shell
                </button>
              )}
              <button
                type="button"
                onClick={() => shellService.setHostPaletteOpen(true)}
                className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/70 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5 shrink-0"
              >
                <Command className="w-3.5 h-3.5 text-[var(--accent)]" />
                Host Palette
              </button>
              <button
                type="button"
                onClick={() => shellService.openHostModal(null)}
                className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/70 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1 shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                SSH Host
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                Local shell is disabled in Web App mode by default. Connect to an SSH host, or
                enable local shell in Settings → Web App.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => shellService.openHostModal(null)}
                  className="h-8 px-3 rounded-md bg-[var(--accent)] text-[#0f111a] text-xs font-medium flex items-center gap-1.5 hover:opacity-90"
                >
                  <Server className="w-3.5 h-3.5" />
                  New SSH Host
                </button>
                <button
                  type="button"
                  onClick={() => shellService.openSettings('web')}
                  className="h-8 px-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/70 text-xs text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1.5"
                >
                  <Settings className="w-3.5 h-3.5" />
                  Web App Settings
                </button>
              </div>
            </div>
          )}

          {/* Saved Workspaces */}
          <div className="border-t border-[var(--border-subtle)] pt-3 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Saved Workspaces ({sortedSavedWorkspaces.length})
              </span>
            </div>
            {sortedSavedWorkspaces.length === 0 ? (
              <div className="px-3 py-2.5 rounded-lg border border-dashed border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                No saved workspaces yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-44 overflow-y-auto lighterm-scroll pr-0.5">
                {sortedSavedWorkspaces.map((ws) => {
                  const isOpen = openSavedIds.has(ws.id);
                  const count = ws.slots.length;
                  const presetLabel = ws.layoutPreset ? ws.layoutPreset.toUpperCase() : 'DOCK';
                  return (
                    <button
                      key={ws.id}
                      type="button"
                      onClick={() => void workspaceManager.openSavedWorkspace(ws.id)}
                      className="w-full px-2.5 py-2 rounded-lg border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]/70 flex items-center justify-between gap-2 text-left transition-colors group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Layers className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                              {ws.name}
                            </span>
                            {isOpen && (
                              <span className="px-1 py-0 rounded text-[9px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] shrink-0">
                                Open
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                            {count} {count === 1 ? 'terminal' : 'terminals'} · {presetLabel}
                          </div>
                        </div>
                      </div>
                      <Play className="w-3 h-3 text-[var(--accent)] opacity-0 group-hover:opacity-100 shrink-0 transition-opacity" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Saved Hosts */}
          <div className="border-t border-[var(--border-subtle)] pt-3 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Saved Hosts ({hosts.length})
              </span>
              <button
                type="button"
                onClick={() => shellService.openHostModal(null)}
                className="text-[11px] text-[var(--accent)] hover:underline flex items-center gap-0.5"
              >
                <Plus className="w-3 h-3" />
                Add
              </button>
            </div>
            {hosts.length === 0 ? (
              <div className="px-3 py-2.5 rounded-lg border border-dashed border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                No saved SSH hosts yet.
              </div>
            ) : (
              <div className="space-y-1 max-h-52 overflow-y-auto lighterm-scroll pr-0.5">
                {hosts.map((host) => (
                  <button
                    key={host.id}
                    type="button"
                    onClick={() =>
                      void shellService.createSshSession({ hostId: host.id, hostConfig: host })
                    }
                    className="w-full px-2.5 py-2 rounded-lg border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]/70 flex items-center justify-between gap-2 text-left transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: host.color || 'var(--accent)' }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {host.name || `${host.username}@${host.host}`}
                        </div>
                        <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                          {host.username}@{host.host}:{host.port}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {host.group && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-app)] text-[var(--text-muted)]">
                          {host.group}
                        </span>
                      )}
                      <Play className="w-3 h-3 text-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right Column: Recent Hosts */}
        <section
          aria-label="Recent Hosts"
          className="rounded-xl border border-[var(--border-subtle)] p-4 flex flex-col gap-3 min-w-0"
          style={{ backgroundColor: 'var(--bg-surface)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Recent Hosts ({resolvedRecentHosts.length})
              </span>
            </div>
            {resolvedRecentHosts.length > 0 && (
              <button
                type="button"
                aria-label="Clear Recent Hosts"
                onClick={() => void shellService.clearRecentHosts()}
                className="text-[11px] text-[var(--text-muted)] hover:text-[var(--danger)] flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                Clear
              </button>
            )}
          </div>

          {resolvedRecentHosts.length === 0 ? (
            <div className="flex-1 min-h-[180px] rounded-lg border border-dashed border-[var(--border-subtle)] flex flex-col items-center justify-center gap-1.5 px-4 text-center">
              <Clock className="w-6 h-6 text-[var(--text-muted)] opacity-50" />
              <p className="text-xs text-[var(--text-muted)]">No recently opened hosts yet.</p>
              <p className="text-[11px] text-[var(--text-muted)]/80">
                Hosts you connect to will appear here for quick reconnect.
              </p>
            </div>
          ) : (
            <div className="space-y-1 max-h-[380px] overflow-y-auto lighterm-scroll pr-0.5">
              {resolvedRecentHosts.map(({ entry }) => (
                <div
                  key={entry.key}
                  className="group rounded-lg border border-transparent hover:border-[var(--border-subtle)] hover:bg-[var(--bg-elevated)]/70 flex items-center justify-between gap-2 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => void shellService.connectRecentHost(entry)}
                    className="flex-1 min-w-0 px-2.5 py-2 flex items-center justify-between gap-2 text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: entry.color || 'var(--accent)' }}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {entry.name}
                        </div>
                        <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                          {entry.username}@{entry.host}:{entry.port}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                      <span className="text-[10px] text-[var(--text-muted)]">
                        {formatRelativeTime(entry.lastConnectedAt)}
                      </span>
                      <span className="text-[10px] px-1.5 py-0 rounded bg-[var(--bg-app)] text-[var(--text-muted)]">
                        {entry.group || (entry.hostId ? 'Saved' : 'Quick')}
                      </span>
                    </div>
                  </button>

                  <button
                    type="button"
                    aria-label={`Remove recent host ${entry.name}`}
                    title="Remove from Recent Hosts"
                    onClick={(e) => {
                      e.stopPropagation();
                      void shellService.removeRecentHost(entry.key);
                    }}
                    className="mr-1.5 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-app)] transition-opacity shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <p className="mt-4 text-[11px] text-[var(--text-muted)] text-center">
        Drag any drawer or floating viewport here to dock.
      </p>
    </div>
  );
};
