import React from 'react';
import { shellService, useShellStore } from '../../core/shellService';

const FONT_PRESETS = [
  "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', monospace",
  "'Fira Code', 'Cascadia Code', 'Noto Sans Mono CJK SC', monospace",
  "'Source Code Pro', 'Ubuntu Mono', monospace",
];

export const TerminalSettingsTab: React.FC = () => {
  const settings = useShellStore((s) => s.settings);

  return (
    <div className="space-y-4">
      <div>
        <label className="block font-semibold text-[var(--text-primary)] mb-1">Font Family</label>
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => void shellService.updateSettings({ fontFamily: e.target.value })}
          className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FONT_PRESETS.map((fp) => (
            <button
              key={fp}
              type="button"
              onClick={() => void shellService.updateSettings({ fontFamily: fp })}
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
            onChange={(e) =>
              void shellService.updateSettings({ fontSize: Number(e.target.value) })
            }
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
              void shellService.updateSettings({ lineHeight: Number(e.target.value) })
            }
            className="w-full accent-[var(--accent)]"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">Cursor Style</span>
          <select
            value={settings.cursorStyle}
            onChange={(e) => void shellService.updateSettings({ cursorStyle: e.target.value })}
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
              void shellService.updateSettings({
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
            onChange={(e) => void shellService.updateSettings({ cursorBlink: e.target.checked })}
          />
          Blink terminal cursor
        </label>
        <label className="flex items-center gap-2 text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={settings.copyOnSelect}
            onChange={(e) => void shellService.updateSettings({ copyOnSelect: e.target.checked })}
          />
          Automatically copy selected text to clipboard
        </label>
      </div>
    </div>
  );
};
