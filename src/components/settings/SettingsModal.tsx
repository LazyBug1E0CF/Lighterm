import React, { useState } from 'react';
import { ChevronDown, Keyboard, Palette, Puzzle, RotateCcw, X } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import {
  usePluginSettingsPages,
  usePluginStatuses,
  useSlotItems,
  type PluginIconComponent,
  type PluginSettingsPageDescriptor,
} from '../../harness';
import { THEME_PRESETS } from '../../themes/presets';
import type { ShortcutMap } from '../../types';
import { DEFAULT_SHORTCUTS, formatKeyboardEvent } from '../../utils/shortcuts';

const SHORTCUT_LABELS: { key: keyof ShortcutMap; label: string }[] = [
  { key: 'newLocalTab', label: 'New Local Terminal Session' },
  { key: 'newHostModal', label: 'New SSH Host Modal' },
  { key: 'splitHorizontal', label: 'Split Terminal Horizontally' },
  { key: 'splitVertical', label: 'Split Terminal Vertically' },
  { key: 'closePane', label: 'Close Active Terminal Viewport' },
  { key: 'findInTerminal', label: 'Find in Terminal' },
  { key: 'commandPalette', label: 'Open Command Palette' },
  { key: 'toggleSidebar', label: 'Toggle SSH Hosts Viewport' },
  { key: 'toggleSftp', label: 'Toggle SFTP Browser Viewport' },
  { key: 'toggleMonitor', label: 'Toggle System Status Viewport' },
  { key: 'openPlugins', label: 'Open Plugin Manager' },
  { key: 'openSettings', label: 'Open Settings' },
  { key: 'nextTab', label: 'Next Terminal Viewport' },
  { key: 'prevTab', label: 'Previous Terminal Viewport' },
];

export const SettingsModal: React.FC = () => {
  const open = useShellStore((s) => s.settingsModalOpen);
  const settings = useShellStore((s) => s.settings);
  const settingsActiveTab = useShellStore((s) => s.settingsActiveTab);
  const pluginStatuses = usePluginStatuses();
  const pluginPages = usePluginSettingsPages();
  const legacyPluginTabs = useSlotItems('settings:tabs');

  const [recordingKey, setRecordingKey] = useState<keyof ShortcutMap | null>(null);
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});

  if (!open) return null;

  const alwaysOnPluginIds = new Set(
    pluginStatuses.filter((p) => p.alwaysOn).map((p) => p.id),
  );

  const unmountedPages = pluginPages.filter((p) => !p.mountTo);
  const baseStandaloneKeys = new Set(unmountedPages.map((p) => `${p.pluginId}:${p.id}`));
  const standaloneByPluginId = new Map<string, string>();
  for (const sp of unmountedPages) {
    if (!standaloneByPluginId.has(sp.pluginId)) {
      standaloneByPluginId.set(sp.pluginId, `${sp.pluginId}:${sp.id}`);
    }
  }

  const resolveMountTarget = (rawMountTo?: string): string | null => {
    const trimmed = rawMountTo?.trim();
    if (!trimmed) return null;
    if (trimmed === 'appearance' || trimmed === 'shortcuts' || baseStandaloneKeys.has(trimmed)) {
      return trimmed;
    }
    if (!trimmed.includes(':') && standaloneByPluginId.has(trimmed)) {
      return standaloneByPluginId.get(trimmed)!;
    }
    return null;
  };

  const standalonePluginPages: PluginSettingsPageDescriptor[] = [];
  const mountedPanelsByTarget = new Map<string, PluginSettingsPageDescriptor[]>();
  const mountedTargetByPageKey = new Map<string, string>();

  for (const page of pluginPages) {
    const target = resolveMountTarget(page.mountTo);
    if (target) {
      const list = mountedPanelsByTarget.get(target) ?? [];
      list.push(page);
      mountedPanelsByTarget.set(target, list);
      mountedTargetByPageKey.set(`${page.pluginId}:${page.id}`, target);
    } else {
      standalonePluginPages.push(page);
    }
  }

  const pageKeys = new Set(standalonePluginPages.map((p) => `${p.pluginId}:${p.id}`));
  const extraLegacyTabs = legacyPluginTabs.filter(
    (t) => !pageKeys.has(`${t.pluginId}:${t.id}`),
  );

  const generalPluginPages = standalonePluginPages.filter((p) => alwaysOnPluginIds.has(p.pluginId));
  const optionalPluginPages = standalonePluginPages.filter((p) => !alwaysOnPluginIds.has(p.pluginId));
  const generalLegacyTabs = extraLegacyTabs.filter((t) => alwaysOnPluginIds.has(t.pluginId));
  const optionalLegacyTabs = extraLegacyTabs.filter((t) => !alwaysOnPluginIds.has(t.pluginId));
  const totalOptionalPluginPages = optionalPluginPages.length + optionalLegacyTabs.length;

  const resolvedActiveTab = mountedTargetByPageKey.get(settingsActiveTab) ?? settingsActiveTab;

  const activePage = standalonePluginPages.find(
    (p) => `${p.pluginId}:${p.id}` === resolvedActiveTab,
  );
  const activeLegacyTab = !activePage
    ? extraLegacyTabs.find((t) => `${t.pluginId}:${t.id}` === resolvedActiveTab)
    : undefined;

  const effectiveTab =
    resolvedActiveTab === 'appearance' ||
    resolvedActiveTab === 'shortcuts' ||
    activePage ||
    activeLegacyTab
      ? resolvedActiveTab
      : 'appearance';

  const ActivePageComponent = activePage?.component;
  const ActivePageIcon = activePage?.icon ?? Puzzle;

  const renderMountedPanels = (targetKey: string) => {
    const panels = mountedPanelsByTarget.get(targetKey);
    if (!panels || panels.length === 0) return null;

    return (
      <div data-mounted-settings-host={targetKey} className="pt-2 space-y-3">
        {panels.map((panel) => {
          const panelKey = `${panel.pluginId}:${panel.id}`;
          const PanelIcon = panel.icon ?? Puzzle;
          const PanelComponent = panel.component;
          const isDirectDeepLink = settingsActiveTab === panelKey;
          const isExpanded = isDirectDeepLink
            ? true
            : (expandedPanels[panelKey] ?? (panel.defaultExpanded ?? true));
          const bodyId = `plugin-panel-body-${panelKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

          return (
            <section
              key={panelKey}
              data-plugin-settings-panel={panel.pluginId}
              data-plugin-settings-panel-key={panelKey}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/35 overflow-hidden"
            >
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={bodyId}
                data-plugin-settings-header={panel.pluginId}
                onClick={() => {
                  const nextExpanded = !isExpanded;
                  setExpandedPanels((prev) => ({ ...prev, [panelKey]: nextExpanded }));
                  if (isDirectDeepLink) {
                    shellService.setSettingsActiveTab(effectiveTab);
                  }
                }}
                className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-[var(--bg-elevated)]/60 transition-colors"
              >
                <span className="flex items-center gap-2 min-w-0 flex-wrap">
                  <PanelIcon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
                    {panel.title}
                  </span>
                  <code className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                    {panel.pluginId}
                  </code>
                </span>
                <ChevronDown
                  className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${
                    isExpanded ? '' : '-rotate-90'
                  }`}
                />
              </button>

              {isExpanded && (
                <div
                  id={bodyId}
                  className="px-3.5 pb-3.5 pt-3 border-t border-[var(--border-subtle)] space-y-3"
                >
                  {panel.description && (
                    <p className="text-[11px] text-[var(--text-muted)]">{panel.description}</p>
                  )}
                  <PanelComponent pluginId={panel.pluginId} />
                </div>
              )}
            </section>
          );
        })}
      </div>
    );
  };

  const renderNavButton = (
    key: string,
    label: string,
    Icon: PluginIconComponent,
    onClick: () => void,
    isActive: boolean,
  ) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-2 rounded-md flex items-center gap-2 text-left transition-colors ${
        isActive
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => shellService.setSettingsModalOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Lighterm Settings</h2>
          <button
            type="button"
            onClick={() => shellService.setSettingsModalOpen(false)}
            aria-label="Close Settings"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Left Navigation: General (core + alwaysOn) & Plugins (optional) */}
          <nav
            aria-label="Settings Navigation"
            className="w-48 p-2 border-r border-[var(--border-subtle)] flex flex-col gap-3 overflow-y-auto lighterm-scroll text-xs shrink-0"
          >
            <div
              data-settings-section="general"
              role="group"
              aria-label="General Settings"
              className="space-y-1"
            >
              <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                General
              </div>
              {renderNavButton(
                'appearance',
                'Appearance',
                Palette,
                () => shellService.setSettingsActiveTab('appearance'),
                effectiveTab === 'appearance',
              )}
              {generalPluginPages.map((page) => {
                const itemKey = `${page.pluginId}:${page.id}`;
                return renderNavButton(
                  itemKey,
                  page.title,
                  page.icon ?? Puzzle,
                  () => shellService.setSettingsActiveTab(itemKey),
                  effectiveTab === itemKey,
                );
              })}
              {generalLegacyTabs.map((item) => {
                const itemKey = `${item.pluginId}:${item.id}`;
                return renderNavButton(
                  itemKey,
                  item.label ?? item.id,
                  Puzzle,
                  () => shellService.setSettingsActiveTab(itemKey),
                  effectiveTab === itemKey,
                );
              })}
              {renderNavButton(
                'shortcuts',
                'Shortcuts',
                Keyboard,
                () => shellService.setSettingsActiveTab('shortcuts'),
                effectiveTab === 'shortcuts',
              )}
            </div>

            <div
              data-settings-section="plugins"
              role="group"
              aria-label="Plugin Settings"
              className="border-t border-[var(--border-subtle)] pt-2.5 space-y-1"
            >
              <div className="px-2.5 py-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <span className="flex items-center gap-1.5">
                  <Puzzle className="w-3 h-3 text-[var(--accent)]" />
                  <span>Plugins</span>
                </span>
                <span className="px-1.5 py-0 rounded bg-[var(--bg-elevated)] font-mono text-[9px]">
                  {totalOptionalPluginPages}
                </span>
              </div>

              {totalOptionalPluginPages === 0 ? (
                <div className="px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
                  No plugin settings available
                </div>
              ) : (
                <>
                  {optionalPluginPages.map((page) => {
                    const itemKey = `${page.pluginId}:${page.id}`;
                    return renderNavButton(
                      itemKey,
                      page.title,
                      page.icon ?? Puzzle,
                      () => shellService.setSettingsActiveTab(itemKey),
                      effectiveTab === itemKey,
                    );
                  })}
                  {optionalLegacyTabs.map((item) => {
                    const itemKey = `${item.pluginId}:${item.id}`;
                    return renderNavButton(
                      itemKey,
                      item.label ?? item.id,
                      Puzzle,
                      () => shellService.setSettingsActiveTab(itemKey),
                      effectiveTab === itemKey,
                    );
                  })}
                </>
              )}
            </div>
          </nav>

          {/* Content */}
          <div className="flex-1 p-4 overflow-y-auto lighterm-scroll text-xs space-y-5">
            {effectiveTab === 'appearance' && (
              <>
                <div>
                  <h3 className="font-semibold text-[var(--text-primary)] mb-2">Color Theme</h3>
                  <div className="grid grid-cols-2 gap-2.5">
                    {THEME_PRESETS.map((preset) => {
                      const active = settings.themeId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => void shellService.updateSettings({ themeId: preset.id })}
                          className={`p-2.5 rounded-lg border text-left transition-all ${
                            active
                              ? 'border-[var(--accent)] ring-1 ring-[var(--accent)]'
                              : 'border-[var(--border-subtle)] hover:border-[var(--accent)]/50'
                          }`}
                          style={{ backgroundColor: preset.ui.bgApp }}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span
                              className="font-medium text-xs"
                              style={{ color: preset.ui.textPrimary }}
                            >
                              {preset.name}
                            </span>
                            <span
                              className="w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: preset.ui.accent }}
                            />
                          </div>
                          <div className="flex items-center gap-1.5 font-mono text-[10px]">
                            <span style={{ color: preset.xterm.green }}>$</span>
                            <span style={{ color: preset.xterm.blue }}>ssh</span>
                            <span style={{ color: preset.xterm.cyan }}>prod-node</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-[var(--text-primary)]">
                      Window &amp; Terminal Opacity
                    </span>
                    <span className="font-mono text-[var(--accent)]">
                      {Math.round(settings.backgroundOpacity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0.6}
                    max={1}
                    step={0.02}
                    value={settings.backgroundOpacity}
                    onChange={(e) =>
                      void shellService.updateSettings({
                        backgroundOpacity: Number(e.target.value),
                      })
                    }
                    className="w-full accent-[var(--accent)]"
                  />
                </div>
                {renderMountedPanels('appearance')}
              </>
            )}

            {activePage && ActivePageComponent && (
              <div className="space-y-4">
                <div
                  data-plugin-settings-header={activePage.pluginId}
                  className="pb-3 border-b border-[var(--border-subtle)]"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <ActivePageIcon className="w-4 h-4 text-[var(--accent)] shrink-0" />
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                      {activePage.title}
                    </h3>
                    <code className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                      {activePage.pluginId}
                    </code>
                  </div>
                  {activePage.description && (
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                      {activePage.description}
                    </p>
                  )}
                </div>

                <ActivePageComponent pluginId={activePage.pluginId} />
                {renderMountedPanels(`${activePage.pluginId}:${activePage.id}`)}
              </div>
            )}

            {activeLegacyTab && activeLegacyTab.render()}

            {effectiveTab === 'shortcuts' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">
                    Click any shortcut button and press your new key combination.
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void shellService.updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } })
                    }
                    className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" /> Reset Defaults
                  </button>
                </div>

                <div className="divide-y divide-[var(--border-subtle)]/60 border border-[var(--border-subtle)] rounded-lg overflow-hidden">
                  {SHORTCUT_LABELS.map(({ key, label }) => {
                    const isRecording = recordingKey === key;
                    return (
                      <div
                        key={key}
                        className="px-3 py-2 flex items-center justify-between bg-[var(--bg-app)]/40"
                      >
                        <span className="text-[var(--text-primary)]">{label}</span>
                        <button
                          type="button"
                          onClick={() => setRecordingKey(isRecording ? null : key)}
                          onKeyDown={(e) => {
                            if (!isRecording) return;
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.key === 'Escape') {
                              setRecordingKey(null);
                              return;
                            }
                            const combo = formatKeyboardEvent(e.nativeEvent);
                            if (combo) {
                              void shellService.updateSettings({
                                shortcuts: { ...settings.shortcuts, [key]: combo },
                              });
                              setRecordingKey(null);
                            }
                          }}
                          className={`min-w-32 h-7 px-2.5 rounded font-mono text-[11px] border transition-colors ${
                            isRecording
                              ? 'border-[var(--accent)] bg-[var(--accent)]/20 text-[var(--accent)]'
                              : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                          }`}
                        >
                          {isRecording ? 'Press keys...' : settings.shortcuts[key]}
                        </button>
                      </div>
                    );
                  })}
                </div>
                {renderMountedPanels('shortcuts')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
