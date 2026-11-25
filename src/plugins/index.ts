import { shellService } from '../core/shellService';
import { windowControls } from '../core/windowControls';
import { workspaceManager } from '../core/workspaceManager';
import { pluginKernel } from '../kernel/PluginKernel';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { historyPlugin } from './history';
import { hostsPlugin } from './hosts';
import { monitorPanelService, monitorPlugin } from './monitor';
import { sftpPlugin } from './sftp';
import { snippetsPlugin } from './snippets';
import { syncClient, syncPlugin } from './sync';
import { terminalPlugin, TERMINAL_VIEWPORT_TYPE } from './terminal';

let bootstrapPromise: Promise<void> | null = null;
let unsubPluginActivated: (() => void) | null = null;

export function registerBuiltinPlugins(kernel = pluginKernel): void {
  kernel.provideCoreService('core:shell', shellService);
  kernel.provideCoreService('core:layout', layoutService);

  kernel.register(terminalPlugin);
  kernel.register(hostsPlugin);
  kernel.register(monitorPlugin);
  kernel.register(sftpPlugin);
  kernel.register(snippetsPlugin);
  kernel.register(historyPlugin);
  kernel.register(syncPlugin);
}

// Populate plugin metadata immediately on module load before the first React render.
registerBuiltinPlugins(pluginKernel);

export async function bootstrapLightermKernel(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    registerBuiltinPlugins(pluginKernel);
    workspaceManager.installAutoSync();

    const isFreshBoot = Object.keys(useLayoutStore.getState().viewports).length === 0;
    const initTask = shellService.initialize();
    const startTask = pluginKernel.start();

    // Built-in drawer plugins activate synchronously on tick 0, so drawer viewports populate before first await.
    if (isFreshBoot) {
      layoutService.mountStartupPluginViewports('drawers');
    }

    await startTask;

    if (isFreshBoot) {
      layoutService.mountStartupPluginViewports('drawers');
    }

    if (shellService.listSessions().length === 0) {
      await shellService.createLocalSession();
    }

    if (isFreshBoot) {
      layoutService.mountStartupPluginViewports('workspace');
    }

    const firstTerminal = layoutService.findViewportsByType(TERMINAL_VIEWPORT_TYPE)[0];
    if (firstTerminal) {
      layoutService.setActiveViewport(firstTerminal.id);
    }

    if (!unsubPluginActivated) {
      unsubPluginActivated = pluginKernel.onPluginActivated((pluginId) => {
        layoutService.mountStartupPluginViewports('all', pluginId);
      });
    }

    await initTask;
  })().catch((err) => {
    bootstrapPromise = null;
    throw err;
  });

  return bootstrapPromise;
}

export function resetLightermKernelForTesting(): void {
  bootstrapPromise = null;
  unsubPluginActivated?.();
  unsubPluginActivated = null;
  workspaceManager.resetForTesting();
  pluginKernel.resetForTesting();
  layoutService.resetForTesting();
  shellService.resetForTesting();
  windowControls.resetForTesting();
  monitorPanelService.resetForTesting();
  syncClient.resetForTesting();
}

export {
  terminalPlugin,
  hostsPlugin,
  monitorPlugin,
  sftpPlugin,
  snippetsPlugin,
  historyPlugin,
  syncPlugin,
};

if (import.meta.hot) {
  import.meta.hot.accept();
}
