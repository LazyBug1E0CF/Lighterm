import React, { useState } from 'react';
import {
  Activity,
  Command,
  Columns2,
  FolderOpen,
  Plus,
  Rows2,
  Server,
  Settings,
  Terminal,
  X,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { findFirstLeaf, findLeafById } from '../../utils/paneTree';

export const TitleBar: React.FC = () => {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const sessionStatuses = useAppStore((s) => s.sessionStatuses);
  const sftpOpen = useAppStore((s) => s.sftpOpen);
  const monitorOpen = useAppStore((s) => s.monitorOpen);
  const openLocalTab = useAppStore((s) => s.openLocalTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const renameTab = useAppStore((s) => s.renameTab);
  const splitActivePane = useAppStore((s) => s.splitActivePane);
  const quickConnectSsh = useAppStore((s) => s.quickConnectSsh);
  const toggleSftpDrawer = useAppStore((s) => s.toggleSftpDrawer);
  const toggleMonitorPanel = useAppStore((s) => s.toggleMonitorPanel);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen);

  const [quickInput, setQuickInput] = useState('');
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const handleQuickSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickInput.trim()) return;
    await quickConnectSsh(quickInput);
    setQuickInput('');
  };

  const commitRename = (tabId: string) => {
    if (renameDraft.trim()) {
      renameTab(tabId, renameDraft);
    }
    setRenamingTabId(null);
  };

  return (
    <header
      className="h-11 shrink-0 flex items-center gap-2 px-3 border-b select-none"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Brand Badge */}
      <div className="flex items-center gap-2 pr-2 border-r border-[var(--border-subtle)] shrink-0">
        <div
          className="w-6 h-6 rounded-md flex items-center justify-center font-mono text-xs font-bold"
          style={{ backgroundColor: 'var(--accent)', color: '#0f111a' }}
        >
          &gt;_
        </div>
        <span className="text-xs font-semibold tracking-wide text-[var(--text-primary)] hidden sm:inline">
          Lighterm
        </span>
      </div>

      {/* Tab Strip */}
      <div className="flex-1 flex items-center gap-1 overflow-x-auto lighterm-scroll min-w-0">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const activeLeaf = findLeafById(tab.root, tab.activePaneId) ?? findFirstLeaf(tab.root);
          const status = sessionStatuses[activeLeaf.sessionId] ?? 'connected';
          const dotColor =
            status === 'connected'
              ? 'var(--success)'
              : status === 'connecting'
                ? 'var(--warning)'
                : status === 'error'
                  ? 'var(--danger)'
                  : 'var(--text-muted)';

          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeTab(tab.id);
                }
              }}
              onDoubleClick={() => {
                setRenamingTabId(tab.id);
                setRenameDraft(tab.title);
              }}
              className={`group flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs cursor-pointer shrink-0 max-w-[190px] border transition-colors ${
                isActive
                  ? 'border-[var(--accent)]/50 bg-[var(--bg-elevated)] text-[var(--text-primary)] font-medium'
                  : 'border-transparent hover:bg-[var(--bg-elevated)]/60 text-[var(--text-muted)]'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: dotColor }}
                title={status}
              />
              {activeLeaf.kind === 'ssh' ? (
                <Server className="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
              ) : (
                <Terminal className="w-3.5 h-3.5 shrink-0 opacity-75" />
              )}

              {renamingTabId === tab.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(tab.id);
                    if (e.key === 'Escape') setRenamingTabId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-24 px-1 py-0.5 text-xs rounded bg-[var(--bg-app)] text-[var(--text-primary)] border border-[var(--accent)] outline-none"
                />
              ) : (
                <span className="truncate">{tab.title}</span>
              )}

              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
                className="ml-0.5 p-0.5 rounded opacity-50 group-hover:opacity-100 hover:bg-white/10 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={() => void openLocalTab()}
          title="New Local Terminal (Ctrl+Shift+T)"
          aria-label="New Local Terminal"
          className="h-7 w-7 rounded-md flex items-center justify-center shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Quick SSH Connect */}
      <form onSubmit={handleQuickSubmit} className="hidden md:flex items-center shrink-0">
        <input
          type="text"
          value={quickInput}
          onChange={(e) => setQuickInput(e.target.value)}
          placeholder="ssh user@host[:port]"
          aria-label="Quick SSH Connect"
          className="w-44 lg:w-52 h-7 px-2.5 text-xs rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
        />
      </form>

      {/* Action Buttons */}
      <div className="flex items-center gap-1 shrink-0 pl-1 border-l border-[var(--border-subtle)]">
        <button
          type="button"
          onClick={() => void splitActivePane('horizontal')}
          title="Split Horizontally (Ctrl+Shift+D)"
          aria-label="Split Horizontally"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Columns2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => void splitActivePane('vertical')}
          title="Split Vertically (Ctrl+Shift+E)"
          aria-label="Split Vertically"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Rows2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => void toggleSftpDrawer()}
          title="Toggle SFTP File Browser (Ctrl+Shift+S)"
          aria-label="Toggle SFTP"
          className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
            sftpOpen
              ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">SFTP</span>
        </button>
        <button
          type="button"
          onClick={toggleMonitorPanel}
          title="Toggle System Status Panel (Ctrl+Shift+M)"
          aria-label="Toggle System Status"
          className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
            monitorOpen
              ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">Status</span>
        </button>
        <button
          type="button"
          onClick={() => setCommandPaletteOpen(true)}
          title="Command Palette (Ctrl+Shift+P)"
          aria-label="Command Palette"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Command className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setSettingsModalOpen(true)}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
