import React, { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ChevronDown,
  Layers,
  PanelLeft,
  PanelRight,
  Puzzle,
  Settings,
  ShieldCheck,
  X,
} from 'lucide-react';
import { isWebRuntime } from '../../core/ipc';
import { shellService, useShellStore } from '../../core/shellService';
import { useWebAuthStore } from '../../core/webTransport';
import {
  useKernel,
  usePluginSettingsPages,
  usePluginStatuses,
  useViewportDescriptors,
  VIEWPORT_POSITION_LABELS,
  type ViewportDescriptor,
} from '../../kernel';
import { layoutService, useLayoutStore } from '../../layout/layoutStore';

export const PluginManagerModal: React.FC = () => {
  const open = useShellStore((s) => s.pluginManagerOpen);
  const sessionCount = useShellStore((s) => s.sessionOrder.length);
  const hostCount = useShellStore((s) => s.hosts.length);
  const webLocalShellEnabled = useWebAuthStore((s) => s.localShellEnabled);
  const localShellAllowed = !isWebRuntime() || webLocalShellEnabled;

  const kernel = useKernel();
  const plugins = usePluginStatuses();
  const descriptors = useViewportDescriptors();
  const settingsPages = usePluginSettingsPages();
  const viewports = useLayoutStore((s) => s.viewports);
  const [expandedViewports, setExpandedViewports] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) {
      setExpandedViewports((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    }
  }, [open]);

  if (!open) return null;

  const togglePluginViewports = (pluginId: string) => {
    setExpandedViewports((prev) => ({
      ...prev,
      [pluginId]: !prev[pluginId],
    }));
  };

  const openDescriptorViewport = (desc: ViewportDescriptor) => {
    if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession();
    } else {
      layoutService.openPluginViewport(desc.typeId);
    }
    shellService.setPluginManagerOpen(false);
  };

  const dockDescriptorToDrawer = (desc: ViewportDescriptor, side: 'left' | 'right') => {
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

  const dockDescriptorToBottom = (desc: ViewportDescriptor) => {
    if (desc.singleton) {
      const existing = layoutService.findViewportsByType(desc.typeId)[0];
      if (existing) {
        layoutService.dockToEdge(existing.id, 'bottom', desc.defaultDockRatio);
      } else {
        layoutService.openViewport({
          typeId: desc.typeId,
          pluginId: desc.pluginId,
          title: desc.title,
          preferredDock: 'bottom',
          dockRatio: desc.defaultDockRatio,
        });
      }
    } else if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession().then((info) => {
        if (!info) return;
        const vp = layoutService
          .findViewportsByType('terminal.viewport')
          .find((v) => String(v.params?.sessionId ?? '') === info.id);
        if (vp) layoutService.dockToEdge(vp.id, 'bottom');
      });
    } else {
      layoutService.openViewport({
        typeId: desc.typeId,
        pluginId: desc.pluginId,
        title: desc.title,
        preferredDock: 'bottom',
        dockRatio: desc.defaultDockRatio,
      });
    }
    shellService.setPluginManagerOpen(false);
  };

  const floatDescriptorViewport = (desc: ViewportDescriptor) => {
    if (desc.singleton) {
      const existing = layoutService.findViewportsByType(desc.typeId)[0];
      if (existing) {
        layoutService.floatViewport(existing.id, desc.defaultFloatSize);
      } else {
        layoutService.openViewport({
          typeId: desc.typeId,
          pluginId: desc.pluginId,
          title: desc.title,
          preferredDock: 'float',
          floatRect: desc.defaultFloatSize,
        });
      }
    } else if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession().then((info) => {
        if (!info) return;
        const vp = layoutService
          .findViewportsByType('terminal.viewport')
          .find((v) => String(v.params?.sessionId ?? '') === info.id);
        if (vp) layoutService.floatViewport(vp.id, desc.defaultFloatSize);
      });
    } else {
      layoutService.openViewport({
        typeId: desc.typeId,
        pluginId: desc.pluginId,
        title: desc.title,
        preferredDock: 'float',
        floatRect: desc.defaultFloatSize,
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
                <span>Minimal Shell &amp; Plugin Kernel</span>
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
              const pluginDescriptors = Object.values(descriptors)
                .filter((d) => d.pluginId === plugin.id)
                .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
              const primaryDesc = pluginDescriptors[0];
              const hasViewport = Boolean(primaryDesc);
              const canSpawnPrimary = Boolean(
                plugin.active &&
                  primaryDesc &&
                  !(primaryDesc.typeId === 'terminal.viewport' && !localShellAllowed),
              );
              const settingsPage = settingsPages.find((p) => p.pluginId === plugin.id);
              const isViewportsExpanded = Boolean(expandedViewports[plugin.id]);
              const viewportsListId = `plugin-viewports-list-${plugin.id}`;

              return (
                <div
                  key={plugin.id}
                  data-plugin-card={plugin.id}
                  className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/50 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-[var(--text-primary)] truncate min-w-0">
                      {plugin.name}
                    </span>

                    <div className="flex items-center gap-1.5 flex-wrap justify-end shrink-0">
                      {canSpawnPrimary && primaryDesc && (
                        <>
                          <button
                            type="button"
                            onClick={() => dockDescriptorToDrawer(primaryDesc, 'left')}
                            title="Add / Move Viewport to Left Drawer"
                            aria-label={`Left Drawer ${plugin.name}`}
                            className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <PanelLeft className="w-3 h-3" />
                            <span>Left</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => dockDescriptorToDrawer(primaryDesc, 'right')}
                            title="Add / Move Viewport to Right Drawer"
                            aria-label={`Right Drawer ${plugin.name}`}
                            className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <PanelRight className="w-3 h-3" />
                            <span>Right</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => dockDescriptorToBottom(primaryDesc)}
                            title="Dock Viewport to Bottom Panel"
                            aria-label={`Bottom Dock ${plugin.name}`}
                            className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <ArrowDownToLine className="w-3 h-3" />
                            <span>Bottom</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => openDescriptorViewport(primaryDesc)}
                            className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                          >
                            <Layers className="w-3 h-3" />
                            <span>{vpCount > 0 ? `Focus (${vpCount})` : 'Open'}</span>
                          </button>
                        </>
                      )}

                      {plugin.active && settingsPage && (
                        <button
                          type="button"
                          onClick={() => {
                            shellService.setPluginManagerOpen(false);
                            shellService.openSettings(`${settingsPage.pluginId}:${settingsPage.id}`);
                          }}
                          title={`Configure ${plugin.name}`}
                          aria-label={`Configure ${plugin.name}`}
                          className="h-7 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                        >
                          <Settings className="w-3 h-3" />
                          <span>Configure</span>
                        </button>
                      )}

                      {plugin.alwaysOn ? (
                        <span
                          aria-label={`${plugin.name} Always On`}
                          className="px-2.5 py-1 rounded-full text-[10px] font-semibold bg-[var(--success)]/20 text-[var(--success)] shrink-0"
                        >
                          Always On
                        </span>
                      ) : (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={plugin.enabled}
                          aria-label={`Toggle ${plugin.name}`}
                          onClick={() => void kernel.togglePlugin(plugin.id)}
                          className={`h-7 px-3 rounded-md font-medium transition-colors ${
                            plugin.enabled
                              ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/50 hover:bg-[var(--danger)]/20 hover:text-[var(--danger)] hover:border-[var(--danger)]/40'
                              : 'bg-[var(--bg-elevated)] text-[var(--text-muted)] border border-[var(--border-subtle)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]'
                          }`}
                        >
                          {plugin.enabled ? 'Disable' : 'Enable'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 flex-wrap">
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
                    {plugin.active && primaryDesc && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                        Default: {VIEWPORT_POSITION_LABELS[primaryDesc.defaultPosition]}
                      </span>
                    )}
                    {plugin.active && pluginDescriptors.length > 1 && (
                      <button
                        type="button"
                        onClick={() => togglePluginViewports(plugin.id)}
                        aria-expanded={isViewportsExpanded}
                        aria-controls={viewportsListId}
                        className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 transition-colors cursor-pointer"
                      >
                        {pluginDescriptors.length} Viewports
                      </button>
                    )}
                  </div>

                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {plugin.description}
                  </p>

                  {plugin.active && hasViewport && pluginDescriptors.length > 1 && (
                    <div
                      data-plugin-viewports={plugin.id}
                      className="pt-2 border-t border-[var(--border-subtle)]/60 space-y-1.5"
                    >
                      <button
                        type="button"
                        aria-expanded={isViewportsExpanded}
                        aria-controls={viewportsListId}
                        data-plugin-viewports-toggle={plugin.id}
                        onClick={() => togglePluginViewports(plugin.id)}
                        className="w-full py-1 px-1.5 -mx-1.5 rounded flex items-center justify-between gap-2 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/60 transition-colors cursor-pointer"
                      >
                        <span className="flex items-center gap-1.5">
                          <ChevronDown
                            className={`w-3.5 h-3.5 shrink-0 transition-transform ${
                              isViewportsExpanded ? '' : '-rotate-90'
                            }`}
                          />
                          <span>Plugin Viewports ({pluginDescriptors.length})</span>
                        </span>
                      </button>
                      {isViewportsExpanded && (
                        <div id={viewportsListId} className="grid grid-cols-1 gap-1">
                          {pluginDescriptors.map((desc) => {
                            const Icon = desc.icon;
                            const instances = Object.values(viewports).filter(
                              (v) => v.typeId === desc.typeId,
                            );
                            return (
                              <div
                                key={desc.typeId}
                                data-plugin-viewport-row={desc.typeId}
                                className="px-2 py-1.5 rounded border border-[var(--border-subtle)]/70 bg-[var(--bg-surface)]/70 flex items-center justify-between gap-2"
                              >
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <Icon className="w-3 h-3 text-[var(--accent)] shrink-0" />
                                  <span className="font-medium text-[var(--text-primary)] truncate">
                                    {desc.title}
                                  </span>
                                  <code className="text-[10px] font-mono text-[var(--text-muted)]">
                                    {desc.typeId}
                                  </code>
                                  <span className="px-1 py-0 rounded bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] shrink-0">
                                    Default: {VIEWPORT_POSITION_LABELS[desc.defaultPosition]}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    aria-label={`Left Drawer Viewport ${desc.title}`}
                                    onClick={() => dockDescriptorToDrawer(desc, 'left')}
                                    className="h-6 px-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                  >
                                    Left
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Right Drawer Viewport ${desc.title}`}
                                    onClick={() => dockDescriptorToDrawer(desc, 'right')}
                                    className="h-6 px-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                  >
                                    Right
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Bottom Dock Viewport ${desc.title}`}
                                    onClick={() => dockDescriptorToBottom(desc)}
                                    className="h-6 px-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                  >
                                    Bottom
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Float Viewport ${desc.title}`}
                                    onClick={() => floatDescriptorViewport(desc)}
                                    className="h-6 px-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                                  >
                                    Float
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Open Viewport ${desc.title}`}
                                    onClick={() => openDescriptorViewport(desc)}
                                    className="h-6 px-2 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-primary)] hover:border-[var(--accent)]"
                                  >
                                    {instances.length > 0 ? `Focus (${instances.length})` : 'Open'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

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
