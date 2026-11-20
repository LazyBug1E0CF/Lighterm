import React from 'react';
import { Layers, PanelLeft, PanelRight, Puzzle, ShieldCheck, X } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { useHarness, usePluginStatuses, useViewportDescriptors } from '../../harness/HarnessContext';
import { layoutService, useLayoutStore } from '../../layout/layoutStore';

export const PluginManagerModal: React.FC = () => {
  const open = useShellStore((s) => s.pluginManagerOpen);
  const sessionCount = useShellStore((s) => s.sessionOrder.length);
  const hostCount = useShellStore((s) => s.hosts.length);

  const harness = useHarness();
  const plugins = usePluginStatuses();
  const descriptors = useViewportDescriptors();
  const viewports = useLayoutStore((s) => s.viewports);

  if (!open) return null;

  const openPluginViewport = (pluginId: string) => {
    const desc = Object.values(descriptors).find((d) => d.pluginId === pluginId);
    if (!desc) return;
    if (desc.singleton) {
      const existing = layoutService.findViewportsByType(desc.typeId)[0];
      if (existing) {
        layoutService.setActiveViewport(existing.id);
      } else {
        layoutService.openViewport({
          typeId: desc.typeId,
          pluginId: desc.pluginId,
          title: desc.title,
          preferredDock: desc.defaultDock,
        });
      }
    } else if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession();
    } else {
      layoutService.openViewport({
        typeId: desc.typeId,
        pluginId: desc.pluginId,
        title: desc.title,
        preferredDock: desc.defaultDock,
      });
    }
    shellService.setPluginManagerOpen(false);
  };

  const dockPluginToDrawer = (pluginId: string, side: 'left' | 'right') => {
    const desc = Object.values(descriptors).find((d) => d.pluginId === pluginId);
    if (!desc) return;
    if (desc.singleton) {
      const existing = layoutService.findViewportsByType(desc.typeId)[0];
      if (existing) {
        layoutService.dockToDrawer(existing.id, side, true);
      } else {
        layoutService.openViewport({
          typeId: desc.typeId,
          pluginId: desc.pluginId,
          title: desc.title,
          preferredDock: side === 'left' ? 'left-drawer' : 'right-drawer',
        });
      }
    } else if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession({ meta: { targetDrawer: side } });
    } else {
      layoutService.openViewport({
        typeId: desc.typeId,
        pluginId: desc.pluginId,
        title: desc.title,
        preferredDock: side === 'left' ? 'left-drawer' : 'right-drawer',
      });
    }
    shellService.setPluginManagerOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => shellService.setPluginManagerOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Plugin Manager"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
          <div className="flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Everything-is-a-Plugin Manager
            </h2>
          </div>
          <button
            type="button"
            onClick={() => shellService.setPluginManagerOpen(false)}
            aria-label="Close Plugin Manager"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto lighterm-scroll p-4 space-y-3 text-xs">
          {/* Minimal Core Status */}
          <div className="p-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <ShieldCheck className="w-4 h-4 text-[var(--accent)] shrink-0" />
                <span>Minimal Shell &amp; Harness Core</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-app)] text-[var(--accent)]">
                  core:shell + core:layout
                </span>
              </div>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Core only handles PTY/SSH2 shell connections, host profiles, and draggable/dockable
                viewport composition ({sessionCount} active shells, {hostCount} saved hosts).
              </p>
            </div>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--success)]/20 text-[var(--success)] shrink-0">
              Always On
            </span>
          </div>

          {/* Registered Plugins */}
          <div className="space-y-2">
            {plugins.map((plugin) => {
              const vpCount = Object.values(viewports).filter(
                (v) => v.pluginId === plugin.id,
              ).length;
              const hasViewport = Object.values(descriptors).some((d) => d.pluginId === plugin.id);

              return (
                <div
                  key={plugin.id}
                  data-plugin-card={plugin.id}
                  className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/50 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-[var(--text-primary)]">
                          {plugin.name}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          {plugin.id}@{plugin.version}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            plugin.active
                              ? 'bg-[var(--success)]/15 text-[var(--success)]'
                              : plugin.missingDependencies.length > 0
                                ? 'bg-[var(--warning)]/15 text-[var(--warning)]'
                                : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                          }`}
                        >
                          {plugin.active
                            ? 'Active'
                            : plugin.missingDependencies.length > 0
                              ? 'Waiting Deps'
                              : 'Disabled'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                        {plugin.description}
                      </p>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {plugin.active && hasViewport && (
                        <>
                          <button
                            type="button"
                            onClick={() => dockPluginToDrawer(plugin.id, 'left')}
                            title="Add / Move Viewport to Left Drawer"
                            aria-label={`Left Drawer ${plugin.name}`}
                            className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <PanelLeft className="w-3 h-3" />
                            <span>Left</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => dockPluginToDrawer(plugin.id, 'right')}
                            title="Add / Move Viewport to Right Drawer"
                            aria-label={`Right Drawer ${plugin.name}`}
                            className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <PanelRight className="w-3 h-3" />
                            <span>Right</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openPluginViewport(plugin.id)}
                            className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <Layers className="w-3 h-3" />
                            <span>{vpCount > 0 ? `Focus (${vpCount})` : 'Open'}</span>
                          </button>
                        </>
                      )}

                      <button
                        type="button"
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`Toggle ${plugin.name}`}
                        onClick={() => void harness.togglePlugin(plugin.id)}
                        className={`h-7 px-3 rounded-md font-medium transition-colors ${
                          plugin.enabled
                            ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50 hover:bg-[var(--danger)]/20 hover:text-[var(--danger)] hover:border-[var(--danger)]/40'
                            : 'bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]'
                        }`}
                      >
                        {plugin.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap text-[10px]">
                    {plugin.inject.length > 0 && (
                      <span className="text-[var(--text-muted)]">
                        inject:{' '}
                        {plugin.inject.map((dep) => (
                          <code
                            key={dep}
                            className="mx-0.5 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)]"
                          >
                            {dep}
                          </code>
                        ))}
                      </span>
                    )}
                    {plugin.provides.length > 0 && (
                      <span className="text-[var(--text-muted)]">
                        provides:{' '}
                        {plugin.provides.map((svc) => (
                          <code
                            key={svc}
                            className="mx-0.5 px-1.5 py-0.5 rounded bg-[var(--accent)]/15 text-[var(--accent)]"
                          >
                            {svc}
                          </code>
                        ))}
                      </span>
                    )}
                  </div>

                  {plugin.error && (
                    <div className="text-[11px] text-[var(--danger)]">{plugin.error}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
