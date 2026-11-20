import React, { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { CommandPaletteModal } from './components/common/CommandPaletteModal';
import { HostFormModal } from './components/hosts/HostFormModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { PluginManagerModal } from './components/shell/PluginManagerModal';
import { ShellStatusBar } from './components/shell/ShellStatusBar';
import { ShellTopBar } from './components/shell/ShellTopBar';
import { invokeTauri, isTauriRuntime } from './core/ipc';
import { shellService, useShellStore } from './core/shellService';
import { HarnessProvider } from './harness/HarnessContext';
import { harnessKernel } from './harness/HarnessKernel';
import { WorkspaceCanvas } from './layout/WorkspaceCanvas';
import { bootstrapLightermHarness } from './plugins';
import { getThemePreset, hexToRgba } from './themes/presets';
import { matchesShortcut } from './utils/shortcuts';

const LightermShell: React.FC = () => {
  const settings = useShellStore((s) => s.settings);
  const statusBannerError = useShellStore((s) => s.statusBannerError);

  useEffect(() => {
    void bootstrapLightermHarness();
  }, []);

  // Reveal the window right after React commits DOM, then enable CSS-controlled transparency post-paint.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let rafId = 0;
    const timerId = window.setTimeout(() => {
      void invokeTauri('window_ready')
        .then(() => {
          rafId = requestAnimationFrame(() => {
            void invokeTauri('window_enable_transparency').catch(() => {});
          });
        })
        .catch(() => {});
    }, 0);
    return () => {
      window.clearTimeout(timerId);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

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

  // Core global keyboard shortcuts (plugin shortcuts are registered per plugin)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useShellStore.getState();
      const sc = state.settings.shortcuts;

      if (matchesShortcut(e, sc.newLocalTab)) {
        e.preventDefault();
        void shellService.createLocalSession();
      } else if (matchesShortcut(e, sc.newHostModal)) {
        e.preventDefault();
        shellService.openHostModal(null);
      } else if (matchesShortcut(e, sc.commandPalette)) {
        e.preventDefault();
        shellService.setCommandPaletteOpen(!state.commandPaletteOpen);
      } else if (matchesShortcut(e, sc.openPlugins)) {
        e.preventDefault();
        shellService.setPluginManagerOpen(!state.pluginManagerOpen);
      } else if (matchesShortcut(e, sc.openSettings)) {
        e.preventDefault();
        shellService.setSettingsModalOpen(!state.settingsModalOpen);
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
      <ShellTopBar />

      {statusBannerError && (
        <div className="px-3 py-1.5 flex items-center justify-between text-xs bg-[var(--danger)]/15 border-b border-[var(--danger)]/40 text-[var(--danger)] shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{statusBannerError}</span>
          </div>
          <button
            type="button"
            onClick={() => shellService.clearBannerError()}
            className="p-0.5 rounded hover:bg-white/10"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <WorkspaceCanvas />

      <ShellStatusBar />

      <HostFormModal />
      <SettingsModal />
      <CommandPaletteModal />
      <PluginManagerModal />
    </div>
  );
};

export const App: React.FC = () => (
  <HarnessProvider kernel={harnessKernel}>
    <LightermShell />
  </HarnessProvider>
);

export default App;
