import React, { useState } from 'react';
import { Keyboard, Palette, RotateCcw, Terminal, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { THEME_PRESETS } from '../../themes/presets';
import type { ShortcutMap } from '../../types';
import { DEFAULT_SHORTCUTS, formatKeyboardEvent } from '../../utils/shortcuts';

const SHORTCUT_LABELS: { key: keyof ShortcutMap; label: string }[] = [
  { key: 'newLocalTab', label: 'New Local Terminal Tab' },
  { key: 'newHostModal', label: 'New SSH Host Modal' },
  { key: 'splitHorizontal', label: 'Split Pane Horizontally' },
  { key: 'splitVertical', label: 'Split Pane Vertically' },
  { key: 'closePane', label: 'Close Active Pane' },
  { key: 'findInTerminal', label: 'Find in Terminal' },
  { key: 'commandPalette', label: 'Open Command Palette' },
  { key: 'toggleSidebar', label: 'Toggle Sidebar' },
  { key: 'toggleSftp', label: 'Toggle SFTP Drawer' },
  { key: 'toggleMonitor', label: 'Toggle System Status Panel' },
  { key: 'openSettings', label: 'Open Settings' },
  { key: 'nextTab', label: 'Next Tab' },
  { key: 'prevTab', label: 'Previous Tab' },
];

const FONT_PRESETS = [
  "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', monospace",
  "'Fira Code', 'Cascadia Code', 'Noto Sans Mono CJK SC', monospace",
  "'Source Code Pro', 'Ubuntu Mono', monospace",
];

export const SettingsModal: React.FC = () => {
  const open = useAppStore((s) => s.settingsModalOpen);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen);

  const [tab, setTab] = useState<'appearance' | 'terminal' | 'shortcuts'>('appearance');
  const [recordingKey, setRecordingKey] = useState<keyof ShortcutMap | null>(null);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => setSettingsModalOpen(false)}
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
            onClick={() => setSettingsModalOpen(false)}
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
            <button
              type="button"
              onClick={() => setTab('terminal')}
              className={`w-full px-3 py-2 rounded-md flex items-center gap-2 ${
                tab === 'terminal'
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" /> Terminal
            </button>
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
                          onClick={() => void updateSettings({ themeId: preset.id })}
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
                      void updateSettings({ backgroundOpacity: Number(e.target.value) })
                    }
                    className="w-full accent-[var(--accent)]"
                  />
                </div>
              </>
            )}

            {tab === 'terminal' && (
              <div className="space-y-4">
                <div>
                  <label className="block font-semibold text-[var(--text-primary)] mb-1">
                    Font Family
                  </label>
                  <input
                    type="text"
                    value={settings.fontFamily}
                    onChange={(e) => void updateSettings({ fontFamily: e.target.value })}
                    className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {FONT_PRESETS.map((fp) => (
                      <button
                        key={fp}
                        type="button"
                        onClick={() => void updateSettings({ fontFamily: fp })}
                        className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        {fp.split(',')[0].replace(/'/g, '')}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="font-semibold text-[var(--text-primary)] block mb-1">
                      Font Size ({settings.fontSize}px)
                    </span>
                    <input
                      type="range"
                      min={10}
                      max={24}
                      step={1}
                      value={settings.fontSize}
                      onChange={(e) => void updateSettings({ fontSize: Number(e.target.value) })}
                      className="w-full accent-[var(--accent)]"
                    />
                  </label>

                  <label className="block">
                    <span className="font-semibold text-[var(--text-primary)] block mb-1">
                      Line Height ({settings.lineHeight.toFixed(2)})
                    </span>
                    <input
                      type="range"
                      min={1.0}
                      max={1.8}
                      step={0.05}
                      value={settings.lineHeight}
                      onChange={(e) =>
                        void updateSettings({ lineHeight: Number(e.target.value) })
                      }
                      className="w-full accent-[var(--accent)]"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="font-semibold text-[var(--text-primary)] block mb-1">
                      Cursor Style
                    </span>
                    <select
                      value={settings.cursorStyle}
                      onChange={(e) => void updateSettings({ cursorStyle: e.target.value })}
                      className="w-full h-8 px-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none"
                    >
                      <option value="bar">Bar</option>
                      <option value="block">Block</option>
                      <option value="underline">Underline</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="font-semibold text-[var(--text-primary)] block mb-1">
                      Scrollback Lines
                    </span>
                    <input
                      type="number"
                      min={500}
                      max={100000}
                      step={500}
                      value={settings.scrollback}
                      onChange={(e) =>
                        void updateSettings({
                          scrollback: Math.max(500, Number(e.target.value) || 5000),
                        })
                      }
                      className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none"
                    />
                  </label>
                </div>

                <div className="flex flex-col gap-2 pt-1">
                  <label className="flex items-center gap-2 text-[var(--text-primary)]">
                    <input
                      type="checkbox"
                      checked={settings.cursorBlink}
                      onChange={(e) => void updateSettings({ cursorBlink: e.target.checked })}
                    />
                    Blink terminal cursor
                  </label>
                  <label className="flex items-center gap-2 text-[var(--text-primary)]">
                    <input
                      type="checkbox"
                      checked={settings.copyOnSelect}
                      onChange={(e) => void updateSettings({ copyOnSelect: e.target.checked })}
                    />
                    Automatically copy selected text to clipboard
                  </label>
                </div>
              </div>
            )}

            {tab === 'shortcuts' && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-muted)]">
                    Click any shortcut button and press your new key combination.
                  </span>
                  <button
                    type="button"
                    onClick={() => void updateSettings({ shortcuts: { ...DEFAULT_SHORTCUTS } })}
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
                              void updateSettings({
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
