import { FolderOpen } from 'lucide-react';
import { type ShellService, useShellStore } from '../../core/shellService';
import { definePlugin } from '../../harness';
import type { LayoutService } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import {
  DEFAULT_SFTP_CONFIG,
  sftpClient,
  subscribeSftpProgressEvents,
  useSftpPluginStore,
  type SftpPluginConfig,
} from './sftpClient';
import { SftpSettingsPage } from './SftpSettingsPage';
import { SftpViewport } from './SftpViewport';

export { DEFAULT_SFTP_CONFIG, type SftpPluginConfig };
export const SFTP_VIEWPORT_TYPE = 'sftp.browser';

export const sftpPlugin = definePlugin({
  id: 'lighterm.sftp',
  name: 'SFTP File Browser',
  version: '1.0.0',
  description: 'Remote SFTP file browser viewport with upload/download and progress telemetry',
  icon: FolderOpen,
  author: 'Lighterm',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    const initialCfg = ctx.getConfig(DEFAULT_SFTP_CONFIG);
    sftpClient.setShowHidden(Boolean(initialCfg.showHiddenByDefault));

    let disposed = false;
    let unlistenProgress: (() => void) | null = null;
    void subscribeSftpProgressEvents()
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenProgress = unlisten;
        }
      })
      .catch(() => {});
    ctx.onCleanup(() => {
      disposed = true;
      unlistenProgress?.();
    });

    ctx.registerViewport({
      typeId: SFTP_VIEWPORT_TYPE,
      title: 'SFTP Browser',
      icon: FolderOpen,
      defaultPosition: 'bottom',
      defaultDockRatio: 0.68,
      defaultFloatSize: { width: 700, height: 340 },
      singleton: true,
      openOnStartup: false,
      order: 20,
      component: SftpViewport,
    });

    ctx.registerSettingsPage({
      id: 'sftp',
      title: 'SFTP Browser',
      description: 'Configure default hidden file visibility and remote starting directory.',
      icon: FolderOpen,
      order: 30,
      component: SftpSettingsPage,
    });

    const openForHost = (hostId: string, defaultPath?: string | null) => {
      const cfg = ctx.getConfig(DEFAULT_SFTP_CONFIG);
      layout.openPluginViewport(SFTP_VIEWPORT_TYPE);
      void sftpClient.openForHost(hostId, defaultPath || cfg.defaultRemotePath || '.');
    };

    const toggle = () => {
      const existing = layout.findViewportsByType(SFTP_VIEWPORT_TYPE)[0];
      if (existing) {
        layout.toggleSingletonViewport({ typeId: SFTP_VIEWPORT_TYPE });
        return;
      }

      const active = shell.getActiveSession();
      const hosts = useShellStore.getState().hosts;
      const activeHostId =
        active?.info.kind === 'ssh' && active.hostId && hosts.some((h) => h.id === active.hostId)
          ? active.hostId
          : null;
      const targetHostId = activeHostId ?? useSftpPluginStore.getState().hostId ?? hosts[0]?.id;

      layout.openPluginViewport(SFTP_VIEWPORT_TYPE);
      if (targetHostId) {
        const host = hosts.find((h) => h.id === targetHostId);
        const cfg = ctx.getConfig(DEFAULT_SFTP_CONFIG);
        void sftpClient.openForHost(targetHostId, host?.defaultPath || cfg.defaultRemotePath || '.');
      }
    };

    ctx.registerSlot({
      id: 'sftp-statusbar-btn',
      slot: 'statusbar:right',
      order: 10,
      render: () => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <FolderOpen className="w-3 h-3" /> SFTP
        </button>
      ),
    });

    ctx.registerSlot({
      id: 'sftp-host-action',
      slot: 'host:actions',
      order: 20,
      render: (context) =>
        context?.host ? (
          <button
            type="button"
            onClick={() => openForHost(context.host!.id, context.host!.defaultPath)}
            title="Browse Files (SFTP)"
            className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-app)] text-[var(--text-muted)] hover:text-[var(--accent)] flex items-center gap-1"
          >
            <FolderOpen className="w-2.5 h-2.5" />
            SFTP
          </button>
        ) : null,
    });

    ctx.registerCommand({
      id: 'sftp:toggle',
      group: 'Action',
      label: 'Toggle SFTP File Browser',
      run: toggle,
    });

    const onKeyDown = (e: KeyboardEvent) => {
      const sc = useShellStore.getState().settings.shortcuts;
      if (matchesShortcut(e, sc.toggleSftp)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
});
