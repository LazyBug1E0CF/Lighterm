import React from 'react';
import { Server } from 'lucide-react';
import { useShellStore } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, useLayoutStore } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import { HostsViewport } from './HostsViewport';

export const HOSTS_VIEWPORT_TYPE = 'hosts.manager';

const HostsToggleButton: React.FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const isOpen = useLayoutStore((s) =>
    Object.values(s.viewports).some((v) => v.typeId === HOSTS_VIEWPORT_TYPE),
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle SSH Hosts Viewport (Ctrl+Shift+B)"
      aria-label="SSH Hosts"
      className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
        isOpen
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <Server className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">Hosts</span>
    </button>
  );
};

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
      defaultDock: 'left',
      defaultFloatSize: { width: 320, height: 480 },
      singleton: true,
      component: HostsViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: HOSTS_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'SSH Hosts',
        preferredDock: 'left',
      });
    };

    ctx.registerSlot({
      id: 'hosts-toggle',
      slot: 'topbar:right',
      order: 20,
      render: () => <HostsToggleButton onToggle={toggle} />,
    });

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
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
};
