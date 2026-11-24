import React, { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { HarnessKernel, harnessKernel } from './HarnessKernel';
import type {
  CommandDescriptor,
  HarnessSnapshot,
  PluginRuntimeStatus,
  PluginSettingsPageDescriptor,
  SlotContribution,
  SlotName,
  ViewportDescriptor,
} from './types';

const HarnessContext = createContext<HarnessKernel>(harnessKernel);

export const HarnessProvider: React.FC<{
  kernel?: HarnessKernel;
  children: React.ReactNode;
}> = ({ kernel = harnessKernel, children }) => (
  <HarnessContext.Provider value={kernel}>{children}</HarnessContext.Provider>
);

export function useHarness(): HarnessKernel {
  return useContext(HarnessContext);
}

export function useHarnessSnapshot(): HarnessSnapshot {
  const kernel = useHarness();
  return useSyncExternalStore(kernel.subscribe, kernel.getSnapshot, kernel.getSnapshot);
}

export function useSlotItems(slot: SlotName): SlotContribution[] {
  const snapshot = useHarnessSnapshot();
  return snapshot.slots[slot];
}

export function usePluginStatuses(): PluginRuntimeStatus[] {
  const snapshot = useHarnessSnapshot();
  return snapshot.statuses;
}

export function useViewportDescriptors(): Record<string, ViewportDescriptor> {
  const snapshot = useHarnessSnapshot();
  return snapshot.viewports;
}

export function usePluginSettingsPages(): PluginSettingsPageDescriptor[] {
  const snapshot = useHarnessSnapshot();
  return snapshot.settingsPages;
}

export function useCommands(): CommandDescriptor[] {
  const snapshot = useHarnessSnapshot();
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
  const kernel = useHarness();
  const snapshot = useHarnessSnapshot();
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
