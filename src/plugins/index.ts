import { shellService } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { historyPlugin } from './history';
import { HOSTS_VIEWPORT_TYPE, hostsPlugin } from './hosts';
import { MONITOR_VIEWPORT_TYPE, monitorPlugin } from './monitor';
import { sftpPlugin } from './sftp';
import { snippetsPlugin } from './snippets';
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

export async function bootstrapLightermHarness(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    registerBuiltinPlugins(harnessKernel);
    await shellService.initialize();
    await harnessKernel.start();

    const layoutState = useLayoutStore.getState();
    if (Object.keys(layoutState.viewports).length === 0) {
      if (shellService.listSessions().length === 0) {
        await shellService.createLocalSession();
      }

      if (harnessKernel.isPluginActive(hostsPlugin.id)) {
        const hostsVp = layoutService.openViewport({
          typeId: HOSTS_VIEWPORT_TYPE,
          pluginId: hostsPlugin.id,
          title: 'SSH Hosts',
          preferredDock: 'left',
        });
        layoutService.dockToEdge(hostsVp.id, 'left', 0.21);
      }

      if (harnessKernel.isPluginActive(monitorPlugin.id)) {
        const monVp = layoutService.openViewport({
          typeId: MONITOR_VIEWPORT_TYPE,
          pluginId: monitorPlugin.id,
          title: 'System Status',
          preferredDock: 'right',
        });
        layoutService.dockToEdge(monVp.id, 'right', 0.76);
      }

      const firstTerminal = layoutService.findViewportsByType(TERMINAL_VIEWPORT_TYPE)[0];
      if (firstTerminal) {
        layoutService.setActiveViewport(firstTerminal.id);
      }
    }
  })();

  return bootstrapPromise;
}

export function resetLightermHarnessForTesting(): void {
  bootstrapPromise = null;
  harnessKernel.resetForTesting();
  layoutService.resetForTesting();
  shellService.resetForTesting();
}

export {
  terminalPlugin,
  hostsPlugin,
  monitorPlugin,
  sftpPlugin,
  snippetsPlugin,
  historyPlugin,
};
