import React, { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { CommandPaletteModal } from './components/common/CommandPaletteModal';
import { HostFormModal } from './components/hosts/HostFormModal';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { TitleBar } from './components/layout/TitleBar';
import { SystemMonitorPanel } from './components/monitor/SystemMonitorPanel';
import { SettingsModal } from './components/settings/SettingsModal';
import { SftpDrawer } from './components/sftp/SftpDrawer';
import { SplitPaneView } from './components/terminal/SplitPaneView';
import { useAppStore } from './store/useAppStore';
import { getThemePreset, hexToRgba } from './themes/presets';
import { matchesShortcut } from './utils/shortcuts';

export const App: React.FC = () => {
  const initializeApp = useAppStore((s) => s.initializeApp);
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const settings = useAppStore((s) => s.settings);
  const statusBannerError = useAppStore((s) => s.statusBannerError);
  const clearBannerError = useAppStore((s) => s.clearBannerError);

  useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  // Sync theme CSS variables & opacity
  useEffect(() => {
    const theme = getThemePreset(settings.themeId);
    const root = document.documentElement;
    root.style.setProperty('--bg-app', hexToRgba(theme.ui.bgApp, settings.backgroundOpacity));
    root.style.setProperty(
      '--bg-surface',
      hexToRgba(theme.ui.bgSurface, Math.min(1, settings.backgroundOpacity + 0.02)),
    );
    root.style.setProperty(
      '--bg-elevated',
      hexToRgba(theme.ui.bgElevated, Math.min(1, settings.backgroundOpacity + 0.04)),
    );
    root.style.setProperty('--border-subtle', theme.ui.borderSubtle);
    root.style.setProperty('--text-primary', theme.ui.textPrimary);
    root.style.setProperty('--text-muted', theme.ui.textMuted);
    root.style.setProperty('--accent', theme.ui.accent);
    root.style.setProperty('--danger', theme.ui.danger);
    root.style.setProperty('--success', theme.ui.success);
    root.style.setProperty('--warning', theme.ui.warning);
  }, [settings.themeId, settings.backgroundOpacity]);

  // Global keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useAppStore.getState();
      const sc = store.settings.shortcuts;

      if (matchesShortcut(e, sc.newLocalTab)) {
        e.preventDefault();
        void store.openLocalTab();
      } else if (matchesShortcut(e, sc.newHostModal)) {
        e.preventDefault();
        store.openHostModal(null);
      } else if (matchesShortcut(e, sc.splitHorizontal)) {
        e.preventDefault();
        void store.splitActivePane('horizontal');
      } else if (matchesShortcut(e, sc.splitVertical)) {
        e.preventDefault();
        void store.splitActivePane('vertical');
      } else if (matchesShortcut(e, sc.closePane)) {
        e.preventDefault();
        const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
        if (activeTab) {
          void store.closePane(activeTab.id, activeTab.activePaneId);
        }
      } else if (matchesShortcut(e, sc.findInTerminal)) {
        e.preventDefault();
        store.triggerTerminalSearch();
      } else if (matchesShortcut(e, sc.commandPalette)) {
        e.preventDefault();
        store.setCommandPaletteOpen(!store.commandPaletteOpen);
      } else if (matchesShortcut(e, sc.toggleSidebar)) {
        e.preventDefault();
        store.toggleSidebar();
      } else if (matchesShortcut(e, sc.toggleSftp)) {
        e.preventDefault();
        void store.toggleSftpDrawer();
      } else if (matchesShortcut(e, sc.toggleMonitor)) {
        e.preventDefault();
        store.toggleMonitorPanel();
      } else if (matchesShortcut(e, sc.openSettings)) {
        e.preventDefault();
        store.setSettingsModalOpen(!store.settingsModalOpen);
      } else if (matchesShortcut(e, sc.nextTab)) {
        e.preventDefault();
        store.cycleTab(1);
      } else if (matchesShortcut(e, sc.prevTab)) {
        e.preventDefault();
        store.cycleTab(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      className="w-screen h-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      <TitleBar />

      {statusBannerError && (
        <div className="px-3 py-1.5 flex items-center justify-between text-xs bg-[var(--danger)]/15 border-b border-[var(--danger)]/40 text-[var(--danger)] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{statusBannerError}</span>
          </div>
          <button
            type="button"
            onClick={clearBannerError}
            className="p-0.5 rounded hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <Sidebar />

        <main className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 flex min-h-0 relative">
            {tabs.map((tab) => {
              const isTabActive = tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={isTabActive ? 'flex-1 flex min-w-0 min-h-0' : 'hidden'}
                >
                  <SplitPaneView
                    tabId={tab.id}
                    node={tab.root}
                    activePaneId={tab.activePaneId}
                    isTabActive={isTabActive}
                  />
                </div>
              );
            })}
          </div>

          <SftpDrawer />
        </main>

        <SystemMonitorPanel />
      </div>

      <StatusBar />

      <HostFormModal />
      <SettingsModal />
      <CommandPaletteModal />
    </div>
  );
};

export default App;
