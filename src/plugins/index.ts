import { shellService } from '../core/shellService';
import { windowControls } from '../core/windowControls';
import { workspaceManager } from '../core/workspaceManager';
import { harnessKernel } from '../harness/HarnessKernel';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { historyPlugin, HISTORY_VIEWPORT_TYPE } from './history';
import { HOSTS_VIEWPORT_TYPE, hostsPlugin } from './hosts';
import { MONITOR_VIEWPORT_TYPE, monitorPanelService, monitorPlugin } from './monitor';
import { sftpPlugin } from './sftp';
import { snippetsPlugin, SNIPPETS_VIEWPORT_TYPE } from './snippets';
import { terminalPlugin, TERMINAL_VIEWPORT_TYPE } from './terminal';

let bootstrapPromise: Promise<void> | null = null;

export function registerBuiltinPlugins(kernel = harnessKernel): void {
  kernel.provideCoreService('core:shell', shellService);
  kernel.provideCoreService('core:layout', layoutService);

  kernel.register(terminalPlugin);
  kernel.register(hostsPlugin);
  kernel.register(monitorPlugin);
  kernel.register(sftpPlugin);
  kernel.register(snippetsPlugin);
  kernel.register(historyPlugin);
}

// Populate plugin metadata immediately on module load before the first React render.
registerBuiltinPlugins(harnessKernel);

export async function bootstrapLightermHarness(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    registerBuiltinPlugins(harnessKernel);
    workspaceManager.installAutoSync();
    const initTask = shellService.initialize();
    const startTask = harnessKernel.start();

    // Built-in plugins activate synchronously on tick 0, so drawer viewports can populate immediately.
    const layoutState = useLayoutStore.getState();
    if (Object.keys(layoutState.viewports).length === 0) {
      if (harnessKernel.isPluginActive(hostsPlugin.id)) {
        layoutService.openViewport({
          typeId: HOSTS_VIEWPORT_TYPE,
          pluginId: hostsPlugin.id,
          title: 'SSH Hosts',
          preferredDock: 'left-drawer',
          activateDrawer: true,
        });
      }

      if (harnessKernel.isPluginActive(snippetsPlugin.id)) {
        layoutService.openViewport({
          typeId: SNIPPETS_VIEWPORT_TYPE,
          pluginId: snippetsPlugin.id,
          title: 'Snippets',
          preferredDock: 'left-drawer',
          activateDrawer: false,
        });
      }

      if (harnessKernel.isPluginActive(historyPlugin.id)) {
        layoutService.openViewport({
          typeId: HISTORY_VIEWPORT_TYPE,
          pluginId: historyPlugin.id,
          title: 'Command History',
          preferredDock: 'left-drawer',
          activateDrawer: false,
        });
      }

      if (harnessKernel.isPluginActive(monitorPlugin.id)) {
        layoutService.openViewport({
          typeId: MONITOR_VIEWPORT_TYPE,
          pluginId: monitorPlugin.id,
          title: 'System Status',
          preferredDock: 'right-drawer',
          activateDrawer: true,
        });
      }
    }

    await startTask;

    if (shellService.listSessions().length === 0) {
      await shellService.createLocalSession();
    }

    const firstTerminal = layoutService.findViewportsByType(TERMINAL_VIEWPORT_TYPE)[0];
    if (firstTerminal) {
      layoutService.setActiveViewport(firstTerminal.id);
    }

    await initTask;
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}

export function resetLightermHarnessForTesting(): void {
  bootstrapPromise = null;
  workspaceManager.resetForTesting();
  harnessKernel.resetForTesting();
  layoutService.resetForTesting();
  shellService.resetForTesting();
  windowControls.resetForTesting();
  monitorPanelService.resetForTesting();
}

export {
  terminalPlugin,
  hostsPlugin,
  monitorPlugin,
  sftpPlugin,
  snippetsPlugin,
  historyPlugin,
};

if (import.meta.hot) {
  import.meta.hot.accept();
}
