import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { PluginKernel, pluginKernel } from './PluginKernel';
import type {
  CommandDescriptor,
  KernelSnapshot,
  PluginRuntimeStatus,
  PluginSettingsPageDescriptor,
  SlotContribution,
  SlotName,
  ViewportDescriptor,
} from './types';

const KernelContext = createContext<PluginKernel>(pluginKernel);

export const KernelProvider: React.FC<{
  kernel?: PluginKernel;
  children: React.ReactNode;
}> = ({ kernel = pluginKernel, children }) => (
  <KernelContext.Provider value={kernel}>{children}</KernelContext.Provider>
);

export function useKernel(): PluginKernel {
  return useContext(KernelContext);
}

export function useKernelSnapshot(): KernelSnapshot {
  const kernel = useKernel();
  return useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
}

export function useSlotItems(slot: SlotName): SlotContribution[] {
  const snapshot = useKernelSnapshot();
  return snapshot.slots[slot];
}

export function usePluginStatuses(): PluginRuntimeStatus[] {
  const snapshot = useKernelSnapshot();
  return snapshot.statuses;
}

export function useViewportDescriptors(): Record<string, ViewportDescriptor> {
  const snapshot = useKernelSnapshot();
  return snapshot.viewports;
}

export function usePluginSettingsPages(): PluginSettingsPageDescriptor[] {
  const snapshot = useKernelSnapshot();
  return snapshot.settingsPages;
}

export function useCommands(): CommandDescriptor[] {
  const snapshot = useKernelSnapshot();
  return snapshot.commands;
}

export function usePluginConfig<T extends Record<string, unknown>>(
  pluginId: string,
  defaults: T,
): {
  config: T;
  updateConfig: (patch: Partial<T>) => Promise<T>;
  resetConfig: () => Promise<T>;
} {
  const kernel = useKernel();
  const snapshot = useKernelSnapshot();
  const raw = snapshot.pluginConfigs[pluginId] ?? kernel.getRawPluginConfig(pluginId);

  const config = useMemo(
    () => ({ ...defaults, ...(raw as Partial<T>) }),
    [defaults, raw],
  );

  const updateConfig = useCallback(
    async (patch: Partial<T>) => {
      const saved = await kernel.updatePluginConfig<T>(pluginId, patch);
      return { ...defaults, ...saved };
    },
    [kernel, pluginId, defaults],
  );

  const resetConfig = useCallback(
    () => kernel.resetPluginConfig<T>(pluginId, defaults),
    [kernel, pluginId, defaults],
  );

  return { config, updateConfig, resetConfig };
}
