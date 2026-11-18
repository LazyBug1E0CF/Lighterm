import React from 'react';
import { Activity, FolderOpen, Server, Terminal } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { getThemePreset } from '../../themes/presets';

export const StatusBar: React.FC = () => {
  const activePane = useAppStore((s) => s.getActivePane());
  const sessionStatuses = useAppStore((s) => s.sessionStatuses);
  const sessionDimensions = useAppStore((s) => s.sessionDimensions);
  const settings = useAppStore((s) => s.settings);
  const toggleSftpDrawer = useAppStore((s) => s.toggleSftpDrawer);
  const toggleMonitorPanel = useAppStore((s) => s.toggleMonitorPanel);
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen);

  const status = activePane ? sessionStatuses[activePane.sessionId] ?? 'connected' : 'disconnected';
  const dims = activePane ? sessionDimensions[activePane.sessionId] : undefined;
  const theme = getThemePreset(settings.themeId);

  return (
    <footer
      className="h-6 px-3 shrink-0 flex items-center justify-between text-[11px] border-t select-none"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[var(--text-primary)]">
          {activePane?.kind === 'ssh' ? (
            <Server className="w-3 h-3 text-[var(--accent)]" />
          ) : (
            <Terminal className="w-3 h-3 text-[var(--success)]" />
          )}
          <span className="truncate">{activePane?.title ?? 'No Active Session'}</span>
          <span className="text-[var(--text-muted)]">({status})</span>
        </div>

        {dims && (
          <span className="font-mono text-[var(--text-muted)] hidden sm:inline">
            {dims.cols}×{dims.rows}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 shrink-0 text-[var(--text-muted)]">
        <button
          type="button"
          onClick={() => void toggleSftpDrawer()}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <FolderOpen className="w-3 h-3" /> SFTP
        </button>
        <button
          type="button"
          onClick={toggleMonitorPanel}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <Activity className="w-3 h-3" /> Status
        </button>
        <button
          type="button"
          onClick={() => setSettingsModalOpen(true)}
          className="hover:text-[var(--text-primary)]"
        >
          {theme.name}
        </button>
      </div>
    </footer>
  );
};
