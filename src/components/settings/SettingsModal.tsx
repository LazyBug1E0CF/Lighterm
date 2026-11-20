import React, { useState } from 'react';
import { Keyboard, Palette, Puzzle, RotateCcw, X } from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { useSlotItems } from '../../harness/HarnessContext';
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
  const pluginSettingsTabs = useSlotItems('settings:tabs');

  const [tab, setTab] = useState<string>('appearance');
  const [recordingKey, setRecordingKey] = useState<keyof ShortcutMap | null>(null);

  if (!open) return null;

  const activePluginTab = pluginSettingsTabs.find((t) => `${t.pluginId}:${t.id}` === tab);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => shellService.setSettingsModalOpen(false)}
    >
      <div
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[82vh]"
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
          {/* Tabs */}
          <div className="w-44 p-2 border-r border-[var(--border-subtle)] space-y-1 text-xs shrink-0">
            <button
              type="button"
              onClick={() => setTab('appearance')}
              className={`w-full px-3 py-2 rounded-md flex items-center gap-2 ${
                tab === 'appearance'
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <Palette className="w-3.5 h-3.5" /> Appearance
            </button>

            {pluginSettingsTabs.map((item) => {
              const itemKey = `${item.pluginId}:${item.id}`;
              return (
                <button
                  key={itemKey}
                  type="button"
                  onClick={() => setTab(itemKey)}
                  className={`w-full px-3 py-2 rounded-md flex items-center gap-2 ${
                    tab === itemKey
                      ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                  }`}
                >
                  <Puzzle className="w-3.5 h-3.5" /> {item.label ?? item.id}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setTab('shortcuts')}
              className={`w-full px-3 py-2 rounded-md flex items-center gap-2 ${
                tab === 'shortcuts'
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <Keyboard className="w-3.5 h-3.5" /> Shortcuts
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 p-4 overflow-y-auto lighterm-scroll text-xs space-y-5">
            {tab === 'appearance' && (
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
              </>
            )}

            {activePluginTab && activePluginTab.render()}

            {tab === 'shortcuts' && (
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
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
