import type React from 'react';
import type { ShellService } from '../core/shellService';
import type { LayoutService } from '../layout/layoutStore';
import type { HostConfig } from '../types';

export interface LightermServiceMap {
  'core:shell': ShellService;
  'core:layout': LayoutService;
}

export type PluginIconComponent = React.ComponentType<{ className?: string }>;

export type SlotName =
  | 'topbar:right'
  | 'statusbar:left'
  | 'statusbar:right'
  | 'host:actions'
  | 'settings:tabs';

export type ViewportPosition =
  | 'left-drawer'
  | 'right-drawer'
  | 'bottom'
  | 'top'
  | 'left'
  | 'right'
  | 'center'
  | 'float';

export type PreferredDockPosition = ViewportPosition;

export const VIEWPORT_POSITIONS: readonly ViewportPosition[] = [
  'left-drawer',
  'right-drawer',
  'bottom',
  'top',
  'left',
  'right',
  'center',
  'float',
];

export const VIEWPORT_POSITION_LABELS: Record<ViewportPosition, string> = {
  'left-drawer': 'Left Drawer',
  'right-drawer': 'Right Drawer',
  bottom: 'Bottom Panel',
  top: 'Top Panel',
  left: 'Left Split',
  right: 'Right Split',
  center: 'Center Tabs',
  float: 'Floating Window',
};

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
  icon: PluginIconComponent;
  defaultPosition: ViewportPosition;
  /** @deprecated Prefer `defaultPosition`; kept in sync as an alias. */
  defaultDock: PreferredDockPosition;
  defaultDockRatio?: number;
  defaultFloatSize?: { width: number; height: number };
  singleton?: boolean;
  openOnStartup?: boolean;
  activateOnStartup?: boolean;
  order?: number;
  component: React.ComponentType<ViewportComponentProps>;
  onClose?: (viewport: ViewportInstanceRef) => void;
}

export type ViewportRegistration = Omit<
  ViewportDescriptor,
  'pluginId' | 'defaultPosition' | 'defaultDock'
> &
  (
    | { defaultPosition: ViewportPosition; defaultDock?: PreferredDockPosition }
    | { defaultDock: PreferredDockPosition; defaultPosition?: ViewportPosition }
  );

export type SettingsMountTarget = 'appearance' | 'shortcuts' | `${string}:${string}` | (string & {});

export interface PluginSettingsPageProps {
  pluginId: string;
}

export interface PluginSettingsPageDescriptor {
  id: string;
  pluginId: string;
  title: string;
  description?: string;
  icon?: PluginIconComponent;
  order?: number;
  mountTo?: SettingsMountTarget;
  defaultExpanded?: boolean;
  component: React.ComponentType<PluginSettingsPageProps>;
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
  inject<T = undefined, K extends string = string>(
    serviceName: K,
  ): [T] extends [undefined]
    ? K extends keyof LightermServiceMap
      ? LightermServiceMap[K]
      : unknown
    : T;
  tryInject<T = undefined, K extends string = string>(
    serviceName: K,
  ):
    | ([T] extends [undefined]
        ? K extends keyof LightermServiceMap
          ? LightermServiceMap[K]
          : unknown
        : T)
    | undefined;
  provide<T>(serviceName: string, impl: T): void;
  registerViewport(descriptor: ViewportRegistration): () => void;
  registerSettingsPage(page: Omit<PluginSettingsPageDescriptor, 'pluginId'>): () => void;
  registerSlot(contribution: Omit<SlotContribution, 'pluginId'>): () => void;
  registerCommand(command: Omit<CommandDescriptor, 'pluginId'>): () => void;
  getConfig<T extends Record<string, unknown>>(defaults: T): T;
  updateConfig<T extends Record<string, unknown>>(patch: Partial<T>): Promise<T>;
  resetConfig<T extends Record<string, unknown>>(defaults?: T): Promise<T>;
  onCleanup(dispose: () => void): void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: PluginIconComponent;
  author?: string;
  inject?: string[];
  provides?: string[];
  defaultEnabled?: boolean;
  alwaysOn?: boolean;
  activate(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

export interface PluginRuntimeStatus {
  id: string;
  name: string;
  version: string;
  description: string;
  icon?: PluginIconComponent;
  author?: string;
  enabled: boolean;
  active: boolean;
  alwaysOn: boolean;
  inject: string[];
  provides: string[];
  missingDependencies: string[];
  error?: string;
}

export interface KernelSnapshot {
  started: boolean;
  revision: number;
  statuses: PluginRuntimeStatus[];
  viewports: Record<string, ViewportDescriptor>;
  settingsPages: PluginSettingsPageDescriptor[];
  pluginConfigs: Record<string, Record<string, unknown>>;
  slots: Record<SlotName, SlotContribution[]>;
  commands: CommandDescriptor[];
}
