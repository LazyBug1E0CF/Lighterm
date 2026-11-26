import React, { useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { CommandPaletteModal } from './components/common/CommandPaletteModal';
import { HostFormModal } from './components/hosts/HostFormModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { PluginManagerModal } from './components/shell/PluginManagerModal';
import { ShellStatusBar } from './components/shell/ShellStatusBar';
import { ShellTopBar } from './components/shell/ShellTopBar';
import { UpdateModal } from './components/shell/UpdateModal';
import { invokeTauri, isTauriRuntime, isWebRuntime } from './core/ipc';
import { shellService, useShellStore } from './core/shellService';
import { updateService } from './core/updateService';
import { useWebAuthStore } from './core/webTransport';
import { useWindowStore, windowControls } from './core/windowControls';
import { WebAuthGate } from './components/shell/WebAuthGate';
import { KernelProvider } from './kernel/KernelContext';
import { pluginKernel } from './kernel/PluginKernel';
import { WorkspaceCanvas } from './layout/WorkspaceCanvas';
import { bootstrapLightermKernel } from './plugins';
import { getThemePreset, hexToRgba } from './themes/presets';
import { matchesShortcut } from './utils/shortcuts';

const LightermShell: React.FC = () => {
  const settings = useShellStore((s) => s.settings);
  const statusBannerError = useShellStore((s) => s.statusBannerError);
  const maximized = useWindowStore((s) => s.maximized);

  useEffect(() => {
    void bootstrapLightermKernel();
    void windowControls.initialize();
    void updateService.initialize();
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
    const bgApp = hexToRgba(theme.ui.bgApp, settings.backgroundOpacity);
    root.style.setProperty('--bg-app', bgApp);
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
    if (!isTauriRuntime()) {
      root.style.backgroundColor = theme.ui.bgApp;
      if (document.body) {
        document.body.style.backgroundColor = theme.ui.bgApp;
      }
    }
  }, [settings.themeId, settings.backgroundOpacity]);

  // Core global keyboard shortcuts (plugin shortcuts are registered per plugin)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useShellStore.getState();
      const sc = state.settings.shortcuts;

      if (matchesShortcut(e, sc.newLocalTab)) {
        e.preventDefault();
        if (isWebRuntime() && !useWebAuthStore.getState().localShellEnabled) {
          shellService.setBannerError(
            "Local shell is disabled. Enable 'Allow Local Shell' in Settings → Web App.",
          );
        } else {
          void shellService.createLocalSession();
        }
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

  // Suppress all default browser/webview right-click context menus while preserving custom app menus
  useEffect(() => {
    const suppressDefaultContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    window.addEventListener('contextmenu', suppressDefaultContextMenu, true);
    return () => window.removeEventListener('contextmenu', suppressDefaultContextMenu, true);
  }, []);

  return (
    <div
      className={`w-screen h-screen flex flex-col overflow-hidden ${
        isWebRuntime() || maximized ? 'border-0' : 'border border-[var(--border-subtle)]/75'
      }`}
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
      <UpdateModal />
    </div>
  );
};

export const App: React.FC = () => {
  const webMode = isWebRuntime();
  const authRequired = useWebAuthStore((s) => s.authRequired);
  const authenticated = useWebAuthStore((s) => s.authenticated);

  if (webMode && authRequired && !authenticated) {
    return <WebAuthGate />;
  }

  return (
    <KernelProvider kernel={pluginKernel}>
      <LightermShell />
    </KernelProvider>
  );
};

export default App;
