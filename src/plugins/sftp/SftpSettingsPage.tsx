import React from 'react';
import { RotateCcw } from 'lucide-react';
import { type PluginSettingsPageProps, usePluginConfig } from '../../harness';
import { DEFAULT_SFTP_CONFIG, sftpClient } from './sftpClient';

export const SftpSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(pluginId, DEFAULT_SFTP_CONFIG);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
        <input
          type="checkbox"
          aria-label="Show hidden files by default"
          checked={Boolean(config.showHiddenByDefault)}
          onChange={(e) => {
            const checked = e.target.checked;
            sftpClient.setShowHidden(checked);
            void updateConfig({ showHiddenByDefault: checked });
          }}
        />
        <span>Show hidden files (dotfiles) by default</span>
      </label>

      <div>
        <label className="block font-semibold text-[var(--text-primary)] mb-1">
          Default Remote Start Path
        </label>
        <input
          type="text"
          aria-label="Default Remote Start Path"
          value={config.defaultRemotePath}
          onChange={(e) => void updateConfig({ defaultRemotePath: e.target.value })}
          placeholder="."
          className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
        />
        <p className="mt-1 text-[11px] text-[var(--text-muted)]">
          Used when a saved SSH host does not specify a custom default path (use{' '}
          <code>.</code> for remote home directory).
        </p>
      </div>

      <div className="pt-2 border-t border-[var(--border-subtle)] flex justify-end">
        <button
          type="button"
          onClick={() => {
            sftpClient.setShowHidden(DEFAULT_SFTP_CONFIG.showHiddenByDefault);
            void resetConfig();
          }}
          className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" />
          Reset Plugin Settings
        </button>
      </div>
    </div>
  );
};
