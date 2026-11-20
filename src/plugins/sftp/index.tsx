import React from 'react';
import { FolderOpen } from 'lucide-react';
import { type ShellService, useShellStore } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, useLayoutStore } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import { sftpClient, subscribeSftpProgressEvents, useSftpPluginStore } from './sftpClient';
import { SftpViewport } from './SftpViewport';

export const SFTP_VIEWPORT_TYPE = 'sftp.browser';

const SftpTopBarButton: React.FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const isOpen = useLayoutStore((s) =>
    Object.values(s.viewports).some((v) => v.typeId === SFTP_VIEWPORT_TYPE),
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle SFTP File Browser (Ctrl+Shift+S)"
      aria-label="Toggle SFTP"
      className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
        isOpen
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <FolderOpen className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">SFTP</span>
    </button>
  );
};

export const sftpPlugin: PluginDefinition = {
  id: 'lighterm.sftp',
  name: 'SFTP File Browser',
  version: '1.0.0',
  description: 'Remote SFTP file browser viewport with upload/download and progress telemetry',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  async activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    const unlistenProgress = await subscribeSftpProgressEvents();
    ctx.onCleanup(unlistenProgress);

    ctx.registerViewport({
      typeId: SFTP_VIEWPORT_TYPE,
      title: 'SFTP Browser',
      icon: FolderOpen,
      defaultDock: 'bottom',
      defaultFloatSize: { width: 700, height: 340 },
      singleton: true,
      component: SftpViewport,
    });

    const openForHost = (hostId: string, defaultPath?: string | null) => {
      const existing = layout.findViewportsByType(SFTP_VIEWPORT_TYPE)[0];
      if (!existing) {
        layout.openViewport({
          typeId: SFTP_VIEWPORT_TYPE,
          pluginId: ctx.pluginId,
          title: 'SFTP Browser',
          preferredDock: 'bottom',
        });
      } else {
        layout.setActiveViewport(existing.id);
      }
      void sftpClient.openForHost(hostId, defaultPath ?? '.');
    };

    const toggle = () => {
      const existing = layout.findViewportsByType(SFTP_VIEWPORT_TYPE)[0];
      if (existing) {
        layout.closeViewport(existing.id);
        return;
      }

      const active = shell.getActiveSession();
      const hosts = useShellStore.getState().hosts;
      const activeHostId =
        active?.info.kind === 'ssh' && active.hostId && hosts.some((h) => h.id === active.hostId)
          ? active.hostId
          : null;
      const targetHostId = activeHostId ?? useSftpPluginStore.getState().hostId ?? hosts[0]?.id;

      layout.openViewport({
        typeId: SFTP_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'SFTP Browser',
        preferredDock: 'bottom',
      });
      if (targetHostId) {
        const host = hosts.find((h) => h.id === targetHostId);
        void sftpClient.openForHost(targetHostId, host?.defaultPath ?? '.');
      }
    };

    ctx.registerSlot({
      id: 'sftp-topbar-btn',
      slot: 'topbar:right',
      order: 30,
      render: () => <SftpTopBarButton onToggle={toggle} />,
    });

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
};
