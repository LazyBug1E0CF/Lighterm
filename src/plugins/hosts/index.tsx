import { Server } from 'lucide-react';
import { useShellStore } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, useLayoutStore } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import { HostsViewport } from './HostsViewport';

export const HOSTS_VIEWPORT_TYPE = 'hosts.manager';

export const hostsPlugin: PluginDefinition = {
  id: 'lighterm.hosts',
  name: 'SSH Hosts Manager',
  version: '1.0.0',
  description: 'Saved SSH host profiles with quick connect and extensible per-host actions',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: HOSTS_VIEWPORT_TYPE,
      title: 'SSH Hosts',
      icon: Server,
      defaultDock: 'left-drawer',
      defaultFloatSize: { width: 320, height: 480 },
      singleton: true,
      component: HostsViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: HOSTS_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'SSH Hosts',
        preferredDock: 'left-drawer',
      });
    };

    const toggleDrawerOrOpen = () => {
      if (useLayoutStore.getState().leftDrawer.viewportIds.length > 0) {
        layout.toggleDrawer('left');
      } else {
        toggle();
      }
    };

    ctx.registerCommand({
      id: 'hosts:toggle',
      group: 'Action',
      label: 'Toggle SSH Hosts Viewport',
      run: toggle,
    });

    const onKeyDown = (e: KeyboardEvent) => {
      const sc = useShellStore.getState().settings.shortcuts;
      if (matchesShortcut(e, sc.toggleSidebar)) {
        e.preventDefault();
        toggleDrawerOrOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
};
