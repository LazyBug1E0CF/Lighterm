import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { HarnessKernel, harnessKernel } from './HarnessKernel';
import type {
  CommandDescriptor,
  HarnessSnapshot,
  PluginRuntimeStatus,
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

export function useCommands(): CommandDescriptor[] {
  const snapshot = useHarnessSnapshot();
  return snapshot.commands;
}
