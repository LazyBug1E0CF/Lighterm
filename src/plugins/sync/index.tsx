import React from 'react';
import { Cloud, CloudAlert, Loader2 } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import { definePlugin } from '../../harness';
import { SYNC_PLUGIN_ID, syncClient, useSyncPluginStore } from './syncClient';
import { SyncSettingsPage } from './SyncSettingsPage';

export { SYNC_PLUGIN_ID, syncClient, useSyncPluginStore };

const SyncStatusBarButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const syncing = useSyncPluginStore((s) => s.syncing);
  const view = useSyncPluginStore((s) => s.view);
  const status = view.status;

  let label = 'Sync';
  let title = 'GitHub Config Sync — Click to sign in with GitHub';
  let icon = <Cloud className="w-3 h-3" />;

  if (syncing) {
    label = 'Syncing...';
    title = 'GitHub Config Sync in progress';
    icon = <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />;
  } else if (status.lastStatus === 'error') {
    label = 'Sync Error';
    title = status.lastError || 'GitHub Config Sync failed';
    icon = <CloudAlert className="w-3 h-3 text-[var(--danger)]" />;
  } else if (view.isAuthenticated && status.lastSyncAt) {
    label = 'Synced';
    title = status.lastMessage || 'Synced with GitHub';
    icon = <Cloud className="w-3 h-3 text-[var(--success)]" />;
  } else if (view.isAuthenticated) {
    label = 'Sync Ready';
    title = `Signed in as @${view.account?.login ?? status.remoteAccount ?? 'GitHub'} — click to sync`;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label="GitHub Sync Status"
      className="flex items-center gap-1 hover:text-[var(--text-primary)]"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
};

export const syncPlugin = definePlugin({
  id: SYNC_PLUGIN_ID,
  name: 'GitHub Config Sync',
  version: '1.0.0',
  description:
    'Synchronize SSH hosts, settings, workspaces, snippets, and plugin configs across devices via GitHub OAuth',
  icon: Cloud,
  author: 'Lighterm',
  inject: ['core:shell'],
  defaultEnabled: true,
  alwaysOn: false,

  activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');

    const openSyncSettings = () => {
      shell.openSettings(`${SYNC_PLUGIN_ID}:sync`);
    };

    ctx.registerSettingsPage({
      id: 'sync',
      title: 'GitHub Sync',
      description:
        'Authorize via GitHub OAuth Device Flow to synchronize SSH hosts, settings, workspaces, snippets, and plugin configs across devices.',
      icon: Cloud,
      order: 50,
      component: SyncSettingsPage,
    });

    ctx.registerSlot({
      id: 'sync-statusbar-btn',
      slot: 'statusbar:right',
      order: 5,
      render: () => <SyncStatusBarButton onClick={openSyncSettings} />,
    });

    ctx.registerCommand({
      id: 'sync:now',
      group: 'Sync',
      label: 'GitHub Sync: Sync Now',
      subtitle: 'Smart 2-way merge with GitHub',
      run: async () => {
        await syncClient.syncNow({ silent: true });
      },
    });

    ctx.registerCommand({
      id: 'sync:push',
      group: 'Sync',
      label: 'GitHub Sync: Push to GitHub',
      subtitle: 'Upload local configuration to GitHub',
      run: async () => {
        await syncClient.push({ silent: true });
      },
    });

    ctx.registerCommand({
      id: 'sync:pull',
      group: 'Sync',
      label: 'GitHub Sync: Pull from GitHub',
      subtitle: 'Restore configuration from GitHub',
      run: async () => {
        await syncClient.pull({ silent: true });
      },
    });

    ctx.registerCommand({
      id: 'sync:settings',
      group: 'Sync',
      label: 'GitHub Sync: Open Settings',
      run: openSyncSettings,
    });

    let disposed = false;
    let debounceTimer: number | null = null;

    const scheduleAutoSync = () => {
      const { view } = useSyncPluginStore.getState();
      if (!view.config.enabled || !view.isAuthenticated || !view.config.autoSyncOnChange) {
        return;
      }
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
      }
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        if (!disposed) {
          void syncClient.syncNow({ silent: true });
        }
      }, 5000);
    };

    const unsubMutated = shell.onConfigMutated(() => {
      scheduleAutoSync();
    });

    void syncClient
      .loadConfig()
      .then((view) => {
        if (disposed) return;
        if (view.config.enabled && view.isAuthenticated && view.config.autoSyncOnStartup) {
          void syncClient.syncNow({ silent: true });
        }
      })
      .catch(() => {});

    ctx.onCleanup(() => {
      disposed = true;
      unsubMutated();
      if (debounceTimer !== null) {
        window.clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    });
  },
});
