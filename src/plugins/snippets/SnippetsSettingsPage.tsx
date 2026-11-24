import React from 'react';
import { RotateCcw } from 'lucide-react';
import { type PluginSettingsPageProps, usePluginConfig } from '../../harness';
import { DEFAULT_SNIPPETS_CONFIG } from './snippetsClient';

export const SnippetsSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(
    pluginId,
    DEFAULT_SNIPPETS_CONFIG,
  );

  return (
    <div className="space-y-4">
      <div>
        <label className="block font-semibold text-[var(--text-primary)] mb-1">
          Default Snippet Category
        </label>
        <input
          type="text"
          aria-label="Default Snippet Category"
          value={config.defaultCategory}
          onChange={(e) => void updateConfig({ defaultCategory: e.target.value })}
          placeholder="General"
          className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </div>

      <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
        <input
          type="checkbox"
          aria-label="Auto-execute new snippets by default"
          checked={Boolean(config.defaultAutoExecute)}
          onChange={(e) => void updateConfig({ defaultAutoExecute: e.target.checked })}
        />
        <span>Auto-execute new snippets immediately when launched from Command Palette</span>
      </label>

      <div className="pt-2 border-t border-[var(--border-subtle)] flex justify-end">
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
