import type React from 'react';
import type { HostConfig } from '../types';

export type SlotName =
  | 'topbar:right'
  | 'statusbar:left'
  | 'statusbar:right'
  | 'host:actions'
  | 'settings:tabs';

export type PreferredDockPosition = 'left' | 'right' | 'top' | 'bottom' | 'center' | 'float';

export interface ViewportInstanceRef {
  id: string;
  typeId: string;
  pluginId: string;
  title: string;
  params?: Record<string, unknown>;
}

export interface ViewportComponentProps {
  viewport: ViewportInstanceRef;
  isActive: boolean;
  isFloating: boolean;
  onClose: () => void;
}

export interface ViewportDescriptor {
  typeId: string;
  pluginId: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  defaultDock: PreferredDockPosition;
  defaultFloatSize?: { width: number; height: number };
  singleton?: boolean;
  component: React.ComponentType<ViewportComponentProps>;
  onClose?: (viewport: ViewportInstanceRef) => void;
}

export interface SlotContribution {
  id: string;
  pluginId: string;
  slot: SlotName;
  order?: number;
  label?: string;
  render: (context?: { host?: HostConfig }) => React.ReactNode;
}

export interface CommandDescriptor {
  id: string;
  pluginId: string;
  group: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  run: () => Promise<void> | void;
}

export interface PluginContext {
  readonly pluginId: string;
  inject<T>(serviceName: string): T;
  tryInject<T>(serviceName: string): T | undefined;
  provide<T>(serviceName: string, impl: T): void;
  registerViewport(descriptor: Omit<ViewportDescriptor, 'pluginId'>): () => void;
  registerSlot(contribution: Omit<SlotContribution, 'pluginId'>): () => void;
  registerCommand(command: Omit<CommandDescriptor, 'pluginId'>): () => void;
  onCleanup(dispose: () => void): void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  inject?: string[];
  provides?: string[];
  defaultEnabled?: boolean;
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

export interface PluginRuntimeStatus {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  active: boolean;
  inject: string[];
  provides: string[];
  missingDependencies: string[];
  error?: string;
}

export interface HarnessSnapshot {
  started: boolean;
  revision: number;
  statuses: PluginRuntimeStatus[];
  viewports: Record<string, ViewportDescriptor>;
  slots: Record<SlotName, SlotContribution[]>;
  commands: CommandDescriptor[];
}
