import { Activity } from 'lucide-react';
import { useShellStore } from '../../core/shellService';
import { definePlugin } from '../../kernel';
import type { LayoutService } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import {
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_MONITOR_PANELS,
  getMonitorPanelViewportType,
  MONITOR_PANEL_CATALOG,
  MONITOR_PROCESSES_VIEWPORT_TYPE,
  monitorPanelService,
  useMonitorPanelStore,
  type MonitorPanelId,
  type MonitorPluginConfig,
} from './monitorPanelStore';
import { MonitorSettingsPage } from './MonitorSettingsPage';
import {
  createMonitorSinglePanelViewport,
  MonitorViewport,
  PANEL_ICON_MAP,
} from './MonitorViewport';

export {
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_MONITOR_PANELS,
  getMonitorPanelViewportType,
  MONITOR_PANEL_CATALOG,
  MONITOR_PROCESSES_VIEWPORT_TYPE,
  monitorPanelService,
  useMonitorPanelStore,
  type MonitorPanelId,
  type MonitorPluginConfig,
};

export const MONITOR_VIEWPORT_TYPE = 'monitor.panel';

export const monitorPlugin = definePlugin({
  id: 'lighterm.monitor',
  name: 'System Status Panel',
  version: '1.0.0',
  description:
    'Real-time CPU, memory, network, disk, and process monitor with detachable modular viewports',
  icon: Activity,
  author: 'Lighterm',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: MONITOR_VIEWPORT_TYPE,
      title: 'System Status',
      icon: Activity,
      defaultPosition: 'right-drawer',
      defaultFloatSize: { width: 320, height: 540 },
      singleton: true,
      openOnStartup: true,
      activateOnStartup: true,
      order: 10,
      component: MonitorViewport,
    });

    for (const meta of MONITOR_PANEL_CATALOG) {
      ctx.registerViewport({
        typeId: meta.viewportTypeId,
        title: meta.title,
        icon: PANEL_ICON_MAP[meta.id],
        defaultPosition: meta.defaultPosition,
        defaultDockRatio: meta.defaultDockRatio,
        defaultFloatSize: meta.defaultFloatSize,
        singleton: true,
        openOnStartup: false,
        activateOnStartup: false,
        order: meta.order,
        component: createMonitorSinglePanelViewport(meta.id),
      });
    }

    ctx.registerSettingsPage({
      id: 'monitor',
      title: 'System Status',
      description: 'Configure telemetry refresh interval, default process sort, and status cards.',
      icon: Activity,
      order: 20,
      component: MonitorSettingsPage,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({ typeId: MONITOR_VIEWPORT_TYPE });
    };

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

    ctx.registerCommand({
      id: 'monitor:reset-panels',
      group: 'Action',
      label: 'Reset System Status Panels Layout',
      run: () => monitorPanelService.resetPanels(),
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
});
