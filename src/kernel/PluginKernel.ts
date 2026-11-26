import { hasBackendRuntime, invokeBackend, readLs, writeLs } from '../core/ipc';
import type { BackendPluginInfo } from '../types';
import {
  VIEWPORT_POSITIONS,
  type CommandDescriptor,
  type KernelSnapshot,
  type PluginContext,
  type PluginDefinition,
  type PluginRuntimeStatus,
  type PluginSettingsPageDescriptor,
  type SlotContribution,
  type SlotName,
  type ViewportDescriptor,
} from './types';

const LS_ENABLED_PLUGINS = 'lighterm:enabled-plugins';
const LS_PLUGIN_CONFIG_PREFIX = 'lighterm:plugin-config:';

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

export function isValidPluginId(id: string): boolean {
  return PLUGIN_ID_PATTERN.test(id);
}

export function validatePluginDefinition(def: PluginDefinition): void {
  if (!isValidPluginId(def.id)) {
    throw new Error(
      `Invalid plugin ID '${def.id}': expected lowercase dot-separated segments (e.g. 'lighterm.sftp')`,
    );
  }
  if (!def.name || !def.name.trim()) {
    throw new Error(`Invalid plugin '${def.id}': name cannot be empty`);
  }
  if (!def.version || !def.version.trim()) {
    throw new Error(`Invalid plugin '${def.id}': version cannot be empty`);
  }
  if (typeof def.activate !== 'function') {
    throw new Error(`Invalid plugin '${def.id}': activate() function is required`);
  }
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  validatePluginDefinition(def);
  return def;
}

function isPromiseLike(val: unknown): val is PromiseLike<unknown> {
  return (
    typeof val === 'object' &&
    val !== null &&
    'then' in val &&
    typeof (val as { then?: unknown }).then === 'function'
  );
}

interface PluginEntry {
  def: PluginDefinition;
  enabled: boolean;
  active: boolean;
  failedActivation?: boolean;
  error?: string;
  disposers: (() => void)[];
  pending?: Promise<void>;
}

const EMPTY_SLOTS = (): Record<SlotName, SlotContribution[]> => ({
  'topbar:right': [],
  'statusbar:left': [],
  'statusbar:right': [],
  'host:actions': [],
  'settings:tabs': [],
});

export class PluginKernel {
  private coreServices = new Map<string, unknown>();
  private pluginServices = new Map<string, { pluginId: string; impl: unknown }>();
  private plugins = new Map<string, PluginEntry>();
  private pluginOrder: string[] = [];

  private viewports = new Map<string, ViewportDescriptor>();
  private settingsPages = new Map<string, PluginSettingsPageDescriptor>();
  private pluginConfigs = new Map<string, { rawLs: string | null; data: Record<string, unknown> }>();
  private slots = EMPTY_SLOTS();
  private commands = new Map<string, CommandDescriptor>();

  private started = false;
  private revision = 0;
  private listeners = new Set<() => void>();
  private activationListeners = new Set<(pluginId: string) => void>();
  private pendingActivations: string[] = [];

  private snapshot: KernelSnapshot = {
    started: false,
    revision: 0,
    statuses: [],
    viewports: {},
    settingsPages: [],
    pluginConfigs: {},
    slots: EMPTY_SLOTS(),
    commands: [],
  };

  private readLsRaw(key: string): string | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null;
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeLsRaw(key: string, value: string | null): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return;
      if (value === null) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // Ignore storage quota or private-mode errors
    }
  }

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

  getRawPluginConfig(pluginId: string): Record<string, unknown> {
    const lsKey = `${LS_PLUGIN_CONFIG_PREFIX}${pluginId}`;
    const hasWindowLs = typeof window !== 'undefined' && Boolean(window.localStorage);
    const cached = this.pluginConfigs.get(pluginId);

    if (hasWindowLs) {
      const rawLs = this.readLsRaw(lsKey);
      if (cached && cached.rawLs === rawLs) {
        return cached.data;
      }
      let parsed: Record<string, unknown> = {};
      if (rawLs) {
        try {
          const val = JSON.parse(rawLs) as unknown;
          if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            parsed = val as Record<string, unknown>;
          }
        } catch {
          parsed = {};
        }
      }
      this.pluginConfigs.set(pluginId, { rawLs, data: parsed });
      return parsed;
    }

    if (cached) {
      return cached.data;
    }
    const empty: Record<string, unknown> = {};
    this.pluginConfigs.set(pluginId, { rawLs: null, data: empty });
    return empty;
  }

  getPluginConfig<T extends Record<string, unknown>>(pluginId: string, defaults: T): T {
    return {
      ...defaults,
      ...(this.getRawPluginConfig(pluginId) as Partial<T>),
    };
  }

  async updatePluginConfig<T extends Record<string, unknown>>(
    pluginId: string,
    patch: Partial<T>,
  ): Promise<T> {
    const lsKey = `${LS_PLUGIN_CONFIG_PREFIX}${pluginId}`;
    const current = this.getRawPluginConfig(pluginId);
    const nextData: Record<string, unknown> = { ...current, ...patch };
    const rawLs = JSON.stringify(nextData);
    this.writeLsRaw(lsKey, rawLs);
    this.pluginConfigs.set(pluginId, { rawLs, data: nextData });
    this.rebuildSnapshot();

    if (hasBackendRuntime()) {
      try {
        await invokeBackend('plugin_config_save', { pluginId, config: nextData });
      } catch {
        // Ignore if backend command is unavailable
      }
    }

    return nextData as T;
  }

  async resetPluginConfig<T extends Record<string, unknown>>(
    pluginId: string,
    defaults?: T,
  ): Promise<T> {
    const lsKey = `${LS_PLUGIN_CONFIG_PREFIX}${pluginId}`;
    this.writeLsRaw(lsKey, null);
    this.pluginConfigs.set(pluginId, { rawLs: null, data: {} });
    this.rebuildSnapshot();

    if (hasBackendRuntime()) {
      try {
        await invokeBackend('plugin_config_reset', { pluginId });
      } catch {
        // Ignore if backend command is unavailable
      }
    }

    return { ...(defaults ?? ({} as T)) };
  }

  async reloadPluginConfigsFromBackend(): Promise<void> {
    if (!hasBackendRuntime()) {
      this.pluginConfigs.clear();
      this.rebuildSnapshot();
      return;
    }

    try {
      const backendConfigs = await invokeBackend<Record<string, Record<string, unknown>>>(
        'plugin_configs_get_all',
      );
      if (!backendConfigs || typeof backendConfigs !== 'object') {
        return;
      }

      const incomingIds = new Set(Object.keys(backendConfigs));
      for (const existingId of [...this.pluginConfigs.keys()]) {
        if (!incomingIds.has(existingId)) {
          this.writeLsRaw(`${LS_PLUGIN_CONFIG_PREFIX}${existingId}`, null);
          this.pluginConfigs.delete(existingId);
        }
      }
      if (typeof window !== 'undefined' && window.localStorage) {
        const keysToRemove: string[] = [];
        for (let i = 0; i < window.localStorage.length; i++) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith(LS_PLUGIN_CONFIG_PREFIX)) {
            const pluginId = key.slice(LS_PLUGIN_CONFIG_PREFIX.length);
            if (!incomingIds.has(pluginId)) {
              keysToRemove.push(key);
            }
          }
        }
        for (const key of keysToRemove) {
          this.writeLsRaw(key, null);
        }
      }

      for (const [pluginId, cfg] of Object.entries(backendConfigs)) {
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
        const rawLs = JSON.stringify(cfg);
        this.writeLsRaw(`${LS_PLUGIN_CONFIG_PREFIX}${pluginId}`, rawLs);
        this.pluginConfigs.set(pluginId, { rawLs, data: { ...cfg } });
      }
      this.rebuildSnapshot();
    } catch {
      // Ignore if backend plugin configs command is unavailable
    }
  }

  async applyPluginEnabledStates(
    states: Record<string, boolean>,
    excludePluginId?: string,
  ): Promise<void> {
    for (const [id, desired] of Object.entries(states)) {
      if (id === excludePluginId) continue;
      const entry = this.plugins.get(id);
      if (!entry || entry.def.alwaysOn) continue;
      const desiredBool = Boolean(desired);
      if (entry.enabled === desiredBool) continue;
      try {
        if (desiredBool) {
          await this.enablePlugin(id);
        } else {
          await this.disablePlugin(id);
        }
      } catch {
        // Ignore individual dependency errors so remaining plugins still reconcile
      }
    }
  }

  onPluginActivated(listener: (pluginId: string) => void): () => void {
    this.activationListeners.add(listener);
    return () => {
      this.activationListeners.delete(listener);
    };
  }

  private drainActivationNotifications(): void {
    if (this.pendingActivations.length === 0) return;
    const ids = this.pendingActivations.splice(0, this.pendingActivations.length);
    for (const id of ids) {
      if (!this.isPluginActive(id)) continue;
      this.activationListeners.forEach((cb) => {
        try {
          cb(id);
        } catch {
          // Isolate listener errors
        }
      });
    }
  }

  register(def: PluginDefinition): void {
    validatePluginDefinition(def);

    const existing = this.plugins.get(def.id);
    if (!existing) {
      this.pluginOrder.push(def.id);
      this.plugins.set(def.id, {
        def,
        enabled: def.alwaysOn ? true : (def.defaultEnabled ?? true),
        active: false,
        disposers: [],
      });
      if (this.started) {
        this.reconcileActivationsSync();
        void this.reconcileActivations().then((changed) => {
          if (changed) {
            this.rebuildSnapshot();
            this.drainActivationNotifications();
          }
        });
      }
      this.rebuildSnapshot();
      this.drainActivationNotifications();
      return;
    }

    if (existing.def === def && existing.active) {
      return;
    }

    if (existing.active) {
      this.deactivateRecursive(def.id, new Set());
    }

    existing.def = def;
    existing.error = undefined;
    existing.failedActivation = false;
    existing.enabled = def.alwaysOn
      ? true
      : this.started
        ? existing.enabled
        : (def.defaultEnabled ?? true);

    if (this.started) {
      this.reconcileActivationsSync();
      void this.reconcileActivations().then((changed) => {
        if (changed) {
          this.rebuildSnapshot();
          this.drainActivationNotifications();
        }
      });
    }
    this.rebuildSnapshot();
    this.drainActivationNotifications();
  }

  async start(initialEnabled?: Record<string, boolean>): Promise<void> {
    const stored = initialEnabled ?? readLs<Record<string, boolean>>(LS_ENABLED_PLUGINS, () => ({}));

    for (const id of this.pluginOrder) {
      const entry = this.plugins.get(id);
      if (!entry) continue;
      if (entry.def.alwaysOn) {
        entry.enabled = true;
      } else if (id in stored) {
        entry.enabled = Boolean(stored[id]);
      } else {
        entry.enabled = entry.def.defaultEnabled ?? true;
      }
    }

    this.started = true;
    // Activate synchronous plugins and populate snapshot before the first await so UI chrome renders on frame 0.
    this.reconcileActivationsSync();
    this.rebuildSnapshot();
    this.drainActivationNotifications();

    if (await this.reconcileActivations()) {
      this.rebuildSnapshot();
      this.drainActivationNotifications();
    }

    if (hasBackendRuntime()) {
      try {
        const backendConfigs = await invokeBackend<Record<string, Record<string, unknown>>>(
          'plugin_configs_get_all',
        );
        if (backendConfigs && typeof backendConfigs === 'object') {
          let configChanged = false;
          for (const [pluginId, cfg] of Object.entries(backendConfigs)) {
            if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
            const rawLs = JSON.stringify(cfg);
            const lsKey = `${LS_PLUGIN_CONFIG_PREFIX}${pluginId}`;
            const prevRaw = this.readLsRaw(lsKey);
            if (prevRaw !== rawLs) {
              this.writeLsRaw(lsKey, rawLs);
              this.pluginConfigs.set(pluginId, { rawLs, data: { ...cfg } });
              configChanged = true;
            }
          }
          if (configChanged) {
            this.rebuildSnapshot();
          }
        }
      } catch {
        // Ignore if backend plugin configs command is unavailable
      }
    }

    if (hasBackendRuntime() && !initialEnabled) {
      try {
        const backendPlugins = await invokeBackend<BackendPluginInfo[]>('plugins_list');
        let backendChanged = false;
        for (const bp of backendPlugins) {
          if (bp.id in stored) continue;
          const entry = this.plugins.get(bp.id);
          if (!entry || entry.def.alwaysOn) continue;
          const desired = Boolean(bp.enabled);
          if (entry.enabled !== desired) {
            entry.enabled = desired;
            if (!desired && entry.active) {
              this.deactivateRecursive(bp.id, new Set());
            }
            backendChanged = true;
          }
        }
        if (backendChanged) {
          await this.reconcileActivations();
          this.rebuildSnapshot();
          this.drainActivationNotifications();
        }
      } catch {
        // Ignore if backend plugin list is unavailable
      }
    }
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
    entry.failedActivation = false;
    await this.syncBackendPlugin(id, true);
    this.persistEnabledStates();

    if (this.started && !entry.active) {
      await this.activateSingle(entry);
      await this.reconcileActivations();
    }
    this.rebuildSnapshot();
    this.drainActivationNotifications();
  }

  async disablePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) {
      throw new Error(`Unknown plugin '${id}'`);
    }
    if (entry.def.alwaysOn) return;

    entry.enabled = false;
    entry.error = undefined;
    entry.failedActivation = false;
    this.deactivateRecursive(id, new Set());
    await this.syncBackendPlugin(id, false);
    this.persistEnabledStates();
    this.rebuildSnapshot();
  }

  async togglePlugin(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry || entry.def.alwaysOn) return;
    if (entry.active || entry.enabled) {
      await this.disablePlugin(id);
    } else {
      await this.enablePlugin(id);
    }
  }

  private async syncBackendPlugin(id: string, enabled: boolean): Promise<void> {
    if (!hasBackendRuntime()) return;
    try {
      await invokeBackend('plugins_set_enabled', { id, enabled });
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

  private canActivate(entry: PluginEntry | undefined): entry is PluginEntry {
    return Boolean(
      entry &&
        entry.enabled &&
        !entry.active &&
        !entry.failedActivation &&
        (entry.def.inject ?? []).every((dep) => this.hasService(dep)),
    );
  }

  private reconcileActivationsSync(): boolean {
    let anyActivated = false;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.pluginOrder) {
        const entry = this.plugins.get(id);
        if (!this.canActivate(entry) || entry.pending) continue;
        const pending = this.tryActivateEntry(entry);
        if (!pending && entry.active) {
          progressed = true;
          anyActivated = true;
        }
      }
    }
    return anyActivated;
  }

  private async reconcileActivations(): Promise<boolean> {
    let anyChanged = false;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const id of this.pluginOrder) {
        const entry = this.plugins.get(id);
        if (!this.canActivate(entry)) continue;
        await this.activateSingle(entry);
        if (entry.active) {
          progressed = true;
          anyChanged = true;
        }
      }
    }
    return anyChanged;
  }

  private createPluginContext(entry: PluginEntry, disposers: (() => void)[]): PluginContext {
    const pluginId = entry.def.id;

    return {
      pluginId,
      inject: ((serviceName: string) => {
        const svc = this.getService(serviceName);
        if (svc === undefined) {
          throw new Error(
            `Plugin '${pluginId}' could not resolve required service '${serviceName}'`,
          );
        }
        return svc;
      }) as PluginContext['inject'],
      tryInject: ((serviceName: string) =>
        this.getService(serviceName)) as PluginContext['tryInject'],
      provide: <T>(serviceName: string, impl: T): void => {
        if (serviceName.startsWith('core:')) {
          throw new Error(
            `Plugin '${pluginId}' cannot provide reserved core service '${serviceName}'`,
          );
        }
        this.pluginServices.set(serviceName, { pluginId, impl });
        disposers.push(() => {
          const current = this.pluginServices.get(serviceName);
          if (current?.pluginId === pluginId) {
            this.pluginServices.delete(serviceName);
          }
        });
      },
      registerViewport: (descriptor): (() => void) => {
        const typeId = descriptor.typeId?.trim();
        if (!typeId) {
          throw new Error(`Plugin '${pluginId}' cannot register viewport with empty typeId`);
        }
        const existing = this.viewports.get(typeId);
        if (existing) {
          throw new Error(
            `Viewport typeId '${typeId}' is already registered by plugin '${existing.pluginId}'`,
          );
        }
        const pos = descriptor.defaultPosition ?? descriptor.defaultDock;
        if (!pos || !VIEWPORT_POSITIONS.includes(pos)) {
          throw new Error(
            `Plugin '${pluginId}' registered viewport '${typeId}' with invalid position '${String(pos)}'`,
          );
        }

        const full: ViewportDescriptor = {
          ...descriptor,
          typeId,
          pluginId,
          defaultPosition: pos,
          defaultDock: pos,
        };
        this.viewports.set(full.typeId, full);
        const remove = () => {
          const cur = this.viewports.get(full.typeId);
          if (cur?.pluginId === pluginId) {
            this.viewports.delete(full.typeId);
          }
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      registerSettingsPage: (page): (() => void) => {
        const pageId = page.id?.trim();
        const title = page.title?.trim();
        if (!pageId) {
          throw new Error(`Plugin '${pluginId}' cannot register settings page with empty id`);
        }
        if (!title) {
          throw new Error(
            `Plugin '${pluginId}' cannot register settings page '${pageId}' with empty title`,
          );
        }
        const key = `${pluginId}:${pageId}`;
        const mountTo = page.mountTo?.trim() || undefined;
        if (mountTo && (mountTo === key || mountTo === pluginId)) {
          throw new Error(
            `Plugin '${pluginId}' settings page '${pageId}' cannot mount to itself ('${mountTo}')`,
          );
        }
        const full: PluginSettingsPageDescriptor = {
          ...page,
          id: pageId,
          title,
          pluginId,
          icon: page.icon ?? entry.def.icon,
          mountTo,
          defaultExpanded: page.defaultExpanded ?? true,
        };
        this.settingsPages.set(key, full);
        const remove = () => {
          const cur = this.settingsPages.get(key);
          if (cur?.pluginId === pluginId) {
            this.settingsPages.delete(key);
          }
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      registerSlot: (contribution): (() => void) => {
        const full: SlotContribution = { ...contribution, pluginId };
        const list = this.slots[full.slot];
        list.push(full);
        list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
        const remove = () => {
          this.slots[full.slot] = this.slots[full.slot].filter(
            (item) => !(item.id === full.id && item.pluginId === pluginId),
          );
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      registerCommand: (command): (() => void) => {
        const full: CommandDescriptor = { ...command, pluginId };
        this.commands.set(full.id, full);
        const remove = () => {
          const cur = this.commands.get(full.id);
          if (cur?.pluginId === pluginId) {
            this.commands.delete(full.id);
          }
        };
        disposers.push(remove);
        return () => {
          remove();
          this.rebuildSnapshot();
        };
      },
      getConfig: <T extends Record<string, unknown>>(defaults: T): T =>
        this.getPluginConfig<T>(pluginId, defaults),
      updateConfig: <T extends Record<string, unknown>>(patch: Partial<T>): Promise<T> =>
        this.updatePluginConfig<T>(pluginId, patch),
      resetConfig: <T extends Record<string, unknown>>(defaults?: T): Promise<T> =>
        this.resetPluginConfig<T>(pluginId, defaults),
      onCleanup: (dispose): void => {
        disposers.push(dispose);
      },
    };
  }

  private tryActivateEntry(entry: PluginEntry): Promise<void> | null {
    if (entry.active) return null;
    if (entry.pending) return entry.pending;

    const disposers: (() => void)[] = [];
    entry.disposers = disposers;
    const ctx = this.createPluginContext(entry, disposers);

    try {
      const result = entry.def.activate(ctx);
      if (isPromiseLike(result)) {
        const pending = Promise.resolve(result)
          .then((cleanup) => {
            if (!entry.enabled || !this.started) {
              if (typeof cleanup === 'function') {
                disposers.push(cleanup);
              }
              this.runDisposers(entry);
              return;
            }
            if (typeof cleanup === 'function') {
              disposers.push(cleanup);
            }
            entry.active = true;
            entry.failedActivation = false;
            entry.error = undefined;
            this.pendingActivations.push(entry.def.id);
          })
          .catch((err) => {
            entry.active = false;
            entry.failedActivation = true;
            entry.error = err instanceof Error ? err.message : String(err);
            this.runDisposers(entry);
          })
          .finally(() => {
            if (entry.pending === pending) {
              entry.pending = undefined;
            }
          });
        entry.pending = pending;
        return pending;
      }

      if (typeof result === 'function') {
        disposers.push(result);
      }
      entry.active = true;
      entry.failedActivation = false;
      entry.error = undefined;
      this.pendingActivations.push(entry.def.id);
      return null;
    } catch (err) {
      entry.active = false;
      entry.failedActivation = true;
      entry.error = err instanceof Error ? err.message : String(err);
      this.runDisposers(entry);
      return null;
    }
  }

  private async activateSingle(entry: PluginEntry): Promise<void> {
    if (entry.active) return;
    const pending = this.tryActivateEntry(entry);
    if (pending) {
      await pending;
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
        icon: entry.def.icon,
        author: entry.def.author,
        enabled: entry.enabled,
        active: entry.active,
        alwaysOn: Boolean(entry.def.alwaysOn),
        inject: entry.def.inject ?? [],
        provides: entry.def.provides ?? [],
        missingDependencies: (entry.def.inject ?? []).filter((dep) => !this.hasService(dep)),
        error: entry.error,
      }));

    const viewportsObj: Record<string, ViewportDescriptor> = {};
    for (const [k, v] of this.viewports.entries()) {
      viewportsObj[k] = v;
    }

    const settingsPages = Array.from(this.settingsPages.values()).sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title),
    );

    const pluginConfigsObj: Record<string, Record<string, unknown>> = {};
    for (const id of this.pluginOrder) {
      pluginConfigsObj[id] = this.getRawPluginConfig(id);
    }
    for (const id of this.pluginConfigs.keys()) {
      if (!(id in pluginConfigsObj)) {
        pluginConfigsObj[id] = this.getRawPluginConfig(id);
      }
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
      settingsPages,
      pluginConfigs: pluginConfigsObj,
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

  getPluginViewportDescriptors(pluginId: string): ViewportDescriptor[] {
    return Array.from(this.viewports.values())
      .filter((desc) => desc.pluginId === pluginId)
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
  }

  getSettingsPages(): PluginSettingsPageDescriptor[] {
    return this.snapshot.settingsPages;
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

  getSnapshot = (): KernelSnapshot => this.snapshot;

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
    this.settingsPages.clear();
    this.pluginConfigs.clear();
    this.slots = EMPTY_SLOTS();
    this.commands.clear();
    this.activationListeners.clear();
    this.pendingActivations = [];
    this.started = false;
    this.rebuildSnapshot();
  }
}

export const pluginKernel = new PluginKernel();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
