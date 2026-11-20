import { invokeTauri, isTauriRuntime, readLs, writeLs } from '../core/ipc';
import type { BackendPluginInfo } from '../types';
import type {
  CommandDescriptor,
  HarnessSnapshot,
  PluginContext,
  PluginDefinition,
  PluginRuntimeStatus,
  SlotContribution,
  SlotName,
  ViewportDescriptor,
} from './types';

const LS_ENABLED_PLUGINS = 'lighterm:enabled-plugins';

interface PluginEntry {
  def: PluginDefinition;
  enabled: boolean;
  active: boolean;
  error?: string;
  disposers: (() => void)[];
}

const EMPTY_SLOTS = (): Record<SlotName, SlotContribution[]> => ({
  'topbar:right': [],
  'statusbar:left': [],
  'statusbar:right': [],
  'host:actions': [],
  'settings:tabs': [],
});

export class HarnessKernel {
  private coreServices = new Map<string, unknown>();
  private pluginServices = new Map<string, { pluginId: string; impl: unknown }>();
  private plugins = new Map<string, PluginEntry>();
  private pluginOrder: string[] = [];

  private viewports = new Map<string, ViewportDescriptor>();
  private slots = EMPTY_SLOTS();
  private commands = new Map<string, CommandDescriptor>();

  private started = false;
  private revision = 0;
  private listeners = new Set<() => void>();
  private snapshot: HarnessSnapshot = {
    started: false,
    revision: 0,
    statuses: [],
    viewports: {},
    slots: EMPTY_SLOTS(),
    commands: [],
  };

  provideCoreService<T>(name: string, service: T): void {
    this.coreServices.set(name, service);
  }

  getService<T>(name: string): T | undefined {
    if (this.coreServices.has(name)) {
      return this.coreServices.get(name) as T;
    }
    return this.pluginServices.get(name)?.impl as T | undefined;
  }

  hasService(name: string): boolean {
    return this.coreServices.has(name) || this.pluginServices.has(name);
  }

  register(def: PluginDefinition): void {
    const existing = this.plugins.get(def.id);
    if (!existing) {
      this.pluginOrder.push(def.id);
    }
    this.plugins.set(def.id, {
      def,
      enabled: def.defaultEnabled ?? true,
      active: false,
      disposers: [],
    });
    this.rebuildSnapshot();
  }

  async start(initialEnabled?: Record<string, boolean>): Promise<void> {
    const stored = initialEnabled ?? readLs<Record<string, boolean>>(LS_ENABLED_PLUGINS, () => ({}));

    if (isTauriRuntime() && !initialEnabled) {
      try {
        const backendPlugins = await invokeTauri<BackendPluginInfo[]>('plugins_list');
        for (const bp of backendPlugins) {
          if (!(bp.id in stored)) {
            stored[bp.id] = bp.enabled;
          }
        }
      } catch {
        // Ignore if backend plugin list is unavailable
      }
    }

    for (const id of this.pluginOrder) {
      const entry = this.plugins.get(id);
      if (!entry) continue;
      if (id in stored) {
        entry.enabled = Boolean(stored[id]);
      } else {
        entry.enabled = entry.def.defaultEnabled ?? true;
      }
    }

    this.started = true;
    await this.reconcileActivations();
    this.rebuildSnapshot();
  }

  async enablePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) {
      throw new Error(`Unknown plugin '${id}'`);
    }

    const missing = (entry.def.inject ?? []).filter((dep) => !this.hasService(dep));
    if (missing.length > 0) {
      entry.error = `Missing required services: ${missing.join(', ')}`;
      this.rebuildSnapshot();
      throw new Error(entry.error);
    }

    entry.enabled = true;
    entry.error = undefined;
    await this.syncBackendPlugin(id, true);
    this.persistEnabledStates();

    if (this.started && !entry.active) {
      await this.activateSingle(entry);
      await this.reconcileActivations();
    }
    this.rebuildSnapshot();
  }

  async disablePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) {
      throw new Error(`Unknown plugin '${id}'`);
    }

    entry.enabled = false;
    entry.error = undefined;
    this.deactivateRecursive(id, new Set());
    await this.syncBackendPlugin(id, false);
    this.persistEnabledStates();
    this.rebuildSnapshot();
  }

  async togglePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) return;
    if (entry.active || entry.enabled) {
      await this.disablePlugin(id);
    } else {
      await this.enablePlugin(id);
    }
  }

  private async syncBackendPlugin(id: string, enabled: boolean): Promise<void> {
    if (!isTauriRuntime()) return;
    try {
      await invokeTauri('plugins_set_enabled', { id, enabled });
    } catch {
      // Frontend-only plugins (e.g., lighterm.terminal, lighterm.hosts) are not registered on Rust side
    }
  }

  private persistEnabledStates(): void {
    const map: Record<string, boolean> = {};
    for (const [id, entry] of this.plugins.entries()) {
      map[id] = entry.enabled;
    }
    writeLs(LS_ENABLED_PLUGINS, map);
  }

  private async reconcileActivations(): Promise<void> {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.pluginOrder) {
        const entry = this.plugins.get(id);
        if (!entry || !entry.enabled || entry.active) continue;
        const depsOk = (entry.def.inject ?? []).every((dep) => this.hasService(dep));
        if (depsOk) {
          await this.activateSingle(entry);
          progressed = true;
        }
      }
    }
  }

  private async activateSingle(entry: PluginEntry): Promise<void> {
    if (entry.active) return;
    const disposers: (() => void)[] = [];
    entry.disposers = disposers;

    const ctx: PluginContext = {
      pluginId: entry.def.id,
      inject: <T>(serviceName: string): T => {
        const svc = this.getService<T>(serviceName);
        if (svc === undefined) {
          throw new Error(
            `Plugin '${entry.def.id}' could not resolve required service '${serviceName}'`,
          );
        }
        return svc;
      },
      tryInject: <T>(serviceName: string): T | undefined => this.getService<T>(serviceName),
      provide: <T>(serviceName: string, impl: T): void => {
        this.pluginServices.set(serviceName, { pluginId: entry.def.id, impl });
        disposers.push(() => {
          const current = this.pluginServices.get(serviceName);
          if (current?.pluginId === entry.def.id) {
            this.pluginServices.delete(serviceName);
          }
        });
      },
      registerViewport: (descriptor): (() => void) => {
        const full: ViewportDescriptor = { ...descriptor, pluginId: entry.def.id };
        this.viewports.set(full.typeId, full);
        const remove = () => {
          const cur = this.viewports.get(full.typeId);
          if (cur?.pluginId === entry.def.id) {
            this.viewports.delete(full.typeId);
          }
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      registerSlot: (contribution): (() => void) => {
        const full: SlotContribution = { ...contribution, pluginId: entry.def.id };
        const list = this.slots[full.slot];
        list.push(full);
        list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        const remove = () => {
          this.slots[full.slot] = this.slots[full.slot].filter(
            (item) => !(item.id === full.id && item.pluginId === entry.def.id),
          );
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      registerCommand: (command): (() => void) => {
        const full: CommandDescriptor = { ...command, pluginId: entry.def.id };
        this.commands.set(full.id, full);
        const remove = () => {
          const cur = this.commands.get(full.id);
          if (cur?.pluginId === entry.def.id) {
            this.commands.delete(full.id);
          }
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      onCleanup: (dispose): void => {
        disposers.push(dispose);
      },
    };

    try {
      const cleanup = await entry.def.activate(ctx);
      if (typeof cleanup === 'function') {
        disposers.push(cleanup);
      }
      entry.active = true;
      entry.error = undefined;
    } catch (err) {
      entry.active = false;
      entry.error = err instanceof Error ? err.message : String(err);
      this.runDisposers(entry);
    }
  }

  private deactivateRecursive(targetId: string, visited: Set<string>): void {
    if (visited.has(targetId)) return;
    visited.add(targetId);

    const entry = this.plugins.get(targetId);
    if (!entry) return;

    const providedServices = new Set<string>(entry.def.provides ?? []);
    for (const [svcName, svcMeta] of this.pluginServices.entries()) {
      if (svcMeta.pluginId === targetId) {
        providedServices.add(svcName);
      }
    }

    if (providedServices.size > 0) {
      for (const otherId of this.pluginOrder) {
        if (otherId === targetId) continue;
        const other = this.plugins.get(otherId);
        if (!other || !other.active) continue;
        const dependsOnTarget = (other.def.inject ?? []).some((dep) => providedServices.has(dep));
        if (dependsOnTarget) {
          this.deactivateRecursive(otherId, visited);
        }
      }
    }

    if (entry.active) {
      entry.active = false;
      this.runDisposers(entry);
    }
  }

  private runDisposers(entry: PluginEntry): void {
    const list = entry.disposers.splice(0, entry.disposers.length);
    for (let i = list.length - 1; i >= 0; i--) {
      try {
        list[i]();
      } catch {
        // Isolate plugin disposal errors so other disposers still execute
      }
    }
  }

  private rebuildSnapshot(): void {
    const statuses: PluginRuntimeStatus[] = this.pluginOrder
      .map((id) => this.plugins.get(id))
      .filter((entry): entry is PluginEntry => Boolean(entry))
      .map((entry) => ({
        id: entry.def.id,
        name: entry.def.name,
        version: entry.def.version,
        description: entry.def.description,
        enabled: entry.enabled,
        active: entry.active,
        inject: entry.def.inject ?? [],
        provides: entry.def.provides ?? [],
        missingDependencies: (entry.def.inject ?? []).filter((dep) => !this.hasService(dep)),
        error: entry.error,
      }));

    const viewportsObj: Record<string, ViewportDescriptor> = {};
    for (const [k, v] of this.viewports.entries()) {
      viewportsObj[k] = v;
    }

    const slotsCopy: Record<SlotName, SlotContribution[]> = {
      'topbar:right': [...this.slots['topbar:right']],
      'statusbar:left': [...this.slots['statusbar:left']],
      'statusbar:right': [...this.slots['statusbar:right']],
      'host:actions': [...this.slots['host:actions']],
      'settings:tabs': [...this.slots['settings:tabs']],
    };

    this.revision += 1;
    this.snapshot = {
      started: this.started,
      revision: this.revision,
      statuses,
      viewports: viewportsObj,
      slots: slotsCopy,
      commands: Array.from(this.commands.values()),
    };

    this.listeners.forEach((cb) => cb());
  }

  getViewportDescriptor(typeId: string): ViewportDescriptor | undefined {
    return this.viewports.get(typeId);
  }

  getViewportDescriptors(): ViewportDescriptor[] {
    return Array.from(this.viewports.values());
  }

  getSlotItems(slot: SlotName): SlotContribution[] {
    return this.snapshot.slots[slot];
  }

  getCommands(): CommandDescriptor[] {
    return this.snapshot.commands;
  }

  getPluginStatuses(): PluginRuntimeStatus[] {
    return this.snapshot.statuses;
  }

  isPluginActive(id: string): boolean {
    return this.plugins.get(id)?.active ?? false;
  }

  getSnapshot = (): HarnessSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  resetForTesting(): void {
    for (const id of [...this.pluginOrder].reverse()) {
      const entry = this.plugins.get(id);
      if (entry) {
        this.runDisposers(entry);
      }
    }
    this.coreServices.clear();
    this.pluginServices.clear();
    this.plugins.clear();
    this.pluginOrder = [];
    this.viewports.clear();
    this.slots = EMPTY_SLOTS();
    this.commands.clear();
    this.started = false;
    this.rebuildSnapshot();
  }
}

export const harnessKernel = new HarnessKernel();
