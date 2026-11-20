import React from 'react';
import { Activity } from 'lucide-react';
import { useShellStore } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, layoutService, useLayoutStore } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import { MonitorViewport } from './MonitorViewport';

export const MONITOR_VIEWPORT_TYPE = 'monitor.panel';

const MonitorTopBarButton: React.FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const isOpen = useLayoutStore(() => layoutService.isViewportOpenOnScreen(MONITOR_VIEWPORT_TYPE));
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle System Status Panel (Ctrl+Shift+M)"
      aria-label="Toggle System Status"
      className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
        isOpen
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <Activity className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">Status</span>
    </button>
  );
};

export const monitorPlugin: PluginDefinition = {
  id: 'lighterm.monitor',
  name: 'System Status Panel',
  version: '1.0.0',
  description: 'Real-time CPU, memory, network, disk, and process monitor viewport',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: MONITOR_VIEWPORT_TYPE,
      title: 'System Status',
      icon: Activity,
      defaultDock: 'right-drawer',
      defaultFloatSize: { width: 320, height: 540 },
      singleton: true,
      component: MonitorViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: MONITOR_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'System Status',
        preferredDock: 'right-drawer',
      });
    };

    ctx.registerSlot({
      id: 'monitor-topbar-btn',
      slot: 'topbar:right',
      order: 40,
      render: () => <MonitorTopBarButton onToggle={toggle} />,
    });

    ctx.registerSlot({
      id: 'monitor-statusbar-btn',
      slot: 'statusbar:right',
      order: 20,
      render: () => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <Activity className="w-3 h-3" /> Status
        </button>
      ),
    });

    ctx.registerCommand({
      id: 'monitor:toggle',
      group: 'Action',
      label: 'Toggle System Status Panel',
      run: toggle,
    });

    const onKeyDown = (e: KeyboardEvent) => {
      const sc = useShellStore.getState().settings.shortcuts;
      if (matchesShortcut(e, sc.toggleMonitor)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
};
