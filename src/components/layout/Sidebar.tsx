import React from 'react';
import { Code2, History, PanelLeftClose, Server, Settings } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { HostListPanel } from '../hosts/HostListPanel';
import { SnippetsPanel } from '../snippets/SnippetsPanel';
import { HistoryPanel } from '../history/HistoryPanel';

export const Sidebar: React.FC = () => {
  const activeSidebarTab = useAppStore((s) => s.activeSidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const setSettingsModalOpen = useAppStore((s) => s.setSettingsModalOpen);

  const navItems = [
    { id: 'hosts' as const, label: 'SSH Hosts', icon: Server },
    { id: 'snippets' as const, label: 'Snippets', icon: Code2 },
    { id: 'history' as const, label: 'Command History', icon: History },
  ];

  return (
    <aside className="flex shrink-0 h-full select-none">
      {/* Activity Rail */}
      <div
        className="w-11 flex flex-col items-center py-2 gap-2 border-r"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeSidebarTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSidebarTab(item.id)}
              title={item.label}
              aria-label={item.label}
              className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                active
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              <Icon className="w-4 h-4" />
            </button>
          );
        })}

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => setSettingsModalOpen(true)}
          title="Settings"
          aria-label="Open Settings"
          className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Collapsible Drawer */}
      {activeSidebarTab && (
        <div
          className="w-68 flex flex-col border-r min-h-0"
          style={{
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <div className="h-9 px-3 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {activeSidebarTab === 'hosts'
                ? 'SSH Hosts'
                : activeSidebarTab === 'snippets'
                  ? 'Snippets'
                  : 'Command History'}
            </span>
            <button
              type="button"
              onClick={() => setSidebarTab(null)}
              title="Collapse Sidebar (Ctrl+Shift+B)"
              aria-label="Collapse Sidebar"
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            {activeSidebarTab === 'hosts' && <HostListPanel />}
            {activeSidebarTab === 'snippets' && <SnippetsPanel />}
            {activeSidebarTab === 'history' && <HistoryPanel />}
          </div>
        </div>
      )}
    </aside>
  );
};
