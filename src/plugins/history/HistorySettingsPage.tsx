import React from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { type PluginSettingsPageProps, usePluginConfig } from '../../kernel';
import { DEFAULT_HISTORY_CONFIG, historyClient, useHistoryPluginStore } from './historyClient';

export const HistorySettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(pluginId, DEFAULT_HISTORY_CONFIG);
  const entryCount = useHistoryPluginStore((s) => s.history.length);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Max History Entries Displayed
          </span>
          <input
            type="number"
            aria-label="Max History Entries Displayed"
            min={20}
            max={1000}
            step={10}
            value={config.maxDisplayEntries}
            onChange={(e) => {
              const next = Math.max(10, Math.min(1000, Number(e.target.value) || 200));
              void updateConfig({ maxDisplayEntries: next });
            }}
            className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>

        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Command Palette History Items
          </span>
          <input
            type="number"
            aria-label="Command Palette History Items"
            min={0}
            max={100}
            step={5}
            value={config.paletteHistoryLimit}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              const next = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 20;
              void updateConfig({ paletteHistoryLimit: next });
            }}
            className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      </div>

      <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void historyClient.clear()}
          disabled={entryCount === 0}
          className="h-7 px-2.5 rounded-md border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/15 disabled:opacity-40 flex items-center gap-1"
        >
          <Trash2 className="w-3 h-3" />
          Clear All History ({entryCount})
        </button>

        <button
          type="button"
          onClick={() => void resetConfig()}
          className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" />
          Reset Plugin Settings
        </button>
      </div>
    </div>
  );
};
