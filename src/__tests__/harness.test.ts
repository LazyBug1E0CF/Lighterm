import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, HarnessKernel } from '../harness';
import type { PluginDefinition } from '../harness/types';

const DummyIcon: React.FC<{ className?: string }> = () => null;
const DummyComp: React.FC = () => null;

describe('HarnessKernel (everything-is-a-plugin)', () => {
  it('resolves inject/provide dependencies, disposes EffectScope on disable, and cascades deactivation', async () => {
    window.localStorage.clear();
    const kernel = new HarnessKernel();
    kernel.provideCoreService('core:shell', { name: 'shell' });

    const cleanupSpy = vi.fn();
    const depCleanupSpy = vi.fn();

    const basePlugin: PluginDefinition = {
      id: 'test.base',
      name: 'Base',
      version: '1.0.0',
      description: 'Base service provider',
      inject: ['core:shell'],
      provides: ['base:api'],
      activate(ctx) {
        const shell = ctx.inject<{ name: string }>('core:shell');
        expect(shell.name).toBe('shell');
        ctx.provide('base:api', { greeting: 'hello' });
        ctx.registerViewport({
          typeId: 'base.vp',
          title: 'Base VP',
          icon: DummyIcon,
          defaultDock: 'center',
          component: DummyComp,
        });
        ctx.registerSlot({
          id: 'base-slot',
          slot: 'topbar:right',
          render: () => 'base-btn',
        });
        ctx.registerCommand({
          id: 'base-cmd',
          group: 'Action',
          label: 'Base Action',
          run: () => {},
        });
        ctx.onCleanup(cleanupSpy);
      },
    };

    const consumerPlugin: PluginDefinition = {
      id: 'test.consumer',
      name: 'Consumer',
      version: '1.0.0',
      description: 'Depends on base:api',
      inject: ['base:api'],
      activate(ctx) {
        const api = ctx.inject<{ greeting: string }>('base:api');
        expect(api.greeting).toBe('hello');
        ctx.registerSlot({
          id: 'consumer-slot',
          slot: 'statusbar:right',
          render: () => 'consumer-btn',
        });
        ctx.onCleanup(depCleanupSpy);
      },
    };

    // Register consumer before base to verify dependency-ordered activation
    kernel.register(consumerPlugin);
    kernel.register(basePlugin);
    await kernel.start();

    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.isPluginActive('test.consumer')).toBe(true);
    expect(kernel.getViewportDescriptor('base.vp')).toBeDefined();
    expect(kernel.getSlotItems('topbar:right')).toHaveLength(1);
    expect(kernel.getSlotItems('statusbar:right')).toHaveLength(1);
    expect(kernel.getCommands()).toHaveLength(1);

    // Disabling base cascades deactivation to consumer and clears all registered viewports/slots/commands
    await kernel.disablePlugin('test.base');

    expect(kernel.isPluginActive('test.base')).toBe(false);
    expect(kernel.isPluginActive('test.consumer')).toBe(false);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
    expect(depCleanupSpy).toHaveBeenCalledTimes(1);
    expect(kernel.getViewportDescriptor('base.vp')).toBeUndefined();
    expect(kernel.getSlotItems('topbar:right')).toHaveLength(0);
    expect(kernel.getSlotItems('statusbar:right')).toHaveLength(0);
    expect(kernel.getCommands()).toHaveLength(0);

    // Consumer cannot activate while base:api is missing
    await expect(kernel.enablePlugin('test.consumer')).rejects.toThrow(/Missing required services/);

    // Re-enabling base automatically reactivates dependent consumer plugin
    await kernel.enablePlugin('test.base');
    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.isPluginActive('test.consumer')).toBe(true);
    expect(kernel.getViewportDescriptor('base.vp')).toBeDefined();
  });

  it('keeps alwaysOn plugins enabled and active even if disabled in storage or via disablePlugin/togglePlugin', async () => {
    window.localStorage.setItem(
      'lighterm:enabled-plugins',
      JSON.stringify({ 'test.always': false }),
    );
    const kernel = new HarnessKernel();
    kernel.provideCoreService('core:shell', { name: 'shell' });

    const disposeSpy = vi.fn();
    kernel.register({
      id: 'test.always',
      name: 'Always Core',
      version: '1.0.0',
      description: 'Cannot be disabled',
      inject: ['core:shell'],
      alwaysOn: true,
      activate(ctx) {
        ctx.onCleanup(disposeSpy);
      },
    });

    await kernel.start();
    expect(kernel.isPluginActive('test.always')).toBe(true);
    expect(kernel.getPluginStatuses()[0]?.alwaysOn).toBe(true);
    expect(kernel.getPluginStatuses()[0]?.enabled).toBe(true);

    await kernel.disablePlugin('test.always');
    await kernel.togglePlugin('test.always');
    expect(kernel.isPluginActive('test.always')).toBe(true);
    expect(disposeSpy).not.toHaveBeenCalled();

    await expect(kernel.disablePlugin('test.missing')).rejects.toThrow(/Unknown plugin/);
  });

  it('handles repeated register() calls across HMR without dropping active plugins or leaking listeners', async () => {
    window.localStorage.clear();
    const kernel = new HarnessKernel();
    kernel.provideCoreService('core:shell', { name: 'shell' });

    let baseV1Activations = 0;
    let baseV2Activations = 0;
    let consumerActivations = 0;
    const baseV1Cleanup = vi.fn();
    const baseV2Cleanup = vi.fn();
    const consumerCleanup = vi.fn();

    const baseV1: PluginDefinition = {
      id: 'test.base',
      name: 'Base',
      version: '1.0.0',
      description: 'Base service provider v1',
      inject: ['core:shell'],
      provides: ['base:api'],
      activate(ctx) {
        baseV1Activations += 1;
        ctx.provide('base:api', { version: 1 });
        ctx.registerViewport({
          typeId: 'base.vp',
          title: 'Base VP',
          icon: DummyIcon,
          defaultDock: 'center',
          component: DummyComp,
        });
        ctx.onCleanup(baseV1Cleanup);
      },
    };

    const consumerDef: PluginDefinition = {
      id: 'test.consumer',
      name: 'Consumer',
      version: '1.0.0',
      description: 'Depends on base:api',
      inject: ['base:api'],
      activate(ctx) {
        consumerActivations += 1;
        ctx.onCleanup(consumerCleanup);
      },
    };

    kernel.register(baseV1);
    kernel.register(consumerDef);
    await kernel.start();

    expect(baseV1Activations).toBe(1);
    expect(consumerActivations).toBe(1);
    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.isPluginActive('test.consumer')).toBe(true);

    // Re-registering the exact same active definition (e.g. parent barrel HMR) is a safe no-op
    kernel.register(baseV1);
    expect(baseV1Activations).toBe(1);
    expect(consumerActivations).toBe(1);
    expect(baseV1Cleanup).not.toHaveBeenCalled();
    expect(consumerCleanup).not.toHaveBeenCalled();
    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.getViewportDescriptor('base.vp')).toBeDefined();

    // Re-registering with a fresh definition object disposes old listeners and reactivates both
    const baseV2: PluginDefinition = {
      ...baseV1,
      version: '1.0.1',
      activate(ctx) {
        baseV2Activations += 1;
        ctx.provide('base:api', { version: 2 });
        ctx.registerViewport({
          typeId: 'base.vp',
          title: 'Base VP',
          icon: DummyIcon,
          defaultDock: 'center',
          component: DummyComp,
        });
        ctx.onCleanup(baseV2Cleanup);
      },
    };

    kernel.register(baseV2);
    expect(baseV1Cleanup).toHaveBeenCalledTimes(1);
    expect(consumerCleanup).toHaveBeenCalledTimes(1);
    expect(baseV2Activations).toBe(1);
    expect(consumerActivations).toBe(2);
    expect(baseV2Cleanup).not.toHaveBeenCalled();
    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.isPluginActive('test.consumer')).toBe(true);
    expect(kernel.getViewportDescriptor('base.vp')).toBeDefined();
    expect(kernel.getService<{ version: number }>('base:api')).toEqual({ version: 2 });

    // Disabled state of dependent plugin is respected when base plugin re-registers
    await kernel.disablePlugin('test.consumer');
    expect(kernel.isPluginActive('test.consumer')).toBe(false);
    kernel.register({ ...baseV2 });
    expect(kernel.isPluginActive('test.base')).toBe(true);
    expect(kernel.isPluginActive('test.consumer')).toBe(false);
  });

  it('validates plugin IDs, reserved core:* services, cross-plugin viewport conflicts, settings pages, and plugin configs', async () => {
    window.localStorage.clear();
    const kernel = new HarnessKernel();
    kernel.provideCoreService('core:shell', { name: 'shell' });

    // 1. Invalid plugin IDs rejected
    expect(() =>
      definePlugin({
        id: 'invalid_id',
        name: 'Bad',
        version: '1.0.0',
        description: 'Missing namespace dot',
        activate() {},
      }),
    ).toThrow(/Invalid plugin ID/);

    expect(() =>
      kernel.register({
        id: 'Bad.Upper',
        name: 'Bad Upper',
        version: '1.0.0',
        description: 'Uppercase rejected',
        activate() {},
      }),
    ).toThrow(/Invalid plugin ID/);

    // 2. Reserved core:* service override fails plugin activation cleanly
    kernel.register(
      definePlugin({
        id: 'acme.hijack',
        name: 'Hijack',
        version: '1.0.0',
        description: 'Attempts to provide core service',
        activate(ctx) {
          ctx.provide('core:shell', { fake: true });
        },
      }),
    );

    // 3. Cross-plugin duplicate viewport typeId fails activation
    kernel.register(
      definePlugin({
        id: 'acme.owner',
        name: 'Owner',
        version: '1.0.0',
        description: 'Owns shared.vp',
        icon: DummyIcon,
        activate(ctx) {
          ctx.registerViewport({
            typeId: 'shared.vp',
            title: 'Owner VP',
            icon: DummyIcon,
            defaultPosition: 'bottom',
            component: DummyComp,
          });
          ctx.registerSettingsPage({
            id: 'owner-cfg',
            title: 'Zeta Settings',
            order: 20,
            component: DummyComp,
          });
        },
      }),
    );

    kernel.register(
      definePlugin({
        id: 'acme.duplicate',
        name: 'Duplicate',
        version: '1.0.0',
        description: 'Tries to steal shared.vp',
        activate(ctx) {
          ctx.registerViewport({
            typeId: 'shared.vp',
            title: 'Stolen VP',
            icon: DummyIcon,
            defaultDock: 'left-drawer',
            component: DummyComp,
          });
        },
      }),
    );

    kernel.register(
      definePlugin({
        id: 'acme.alpha',
        name: 'Alpha',
        version: '1.0.0',
        description: 'Legacy defaultDock normalization & early settings order',
        activate(ctx) {
          ctx.registerViewport({
            typeId: 'alpha.vp',
            title: 'Alpha VP',
            icon: DummyIcon,
            defaultDock: 'left-drawer',
            component: DummyComp,
          });
          ctx.registerSettingsPage({
            id: 'alpha-cfg',
            title: 'Alpha Settings',
            icon: DummyIcon,
            order: 10,
            component: DummyComp,
          });
        },
      }),
    );

    const activatedSpy = vi.fn();
    kernel.onPluginActivated(activatedSpy);

    await kernel.start();

    expect(kernel.isPluginActive('acme.hijack')).toBe(false);
    expect(kernel.getPluginStatuses().find((p) => p.id === 'acme.hijack')?.error).toMatch(
      /reserved core service/,
    );

    expect(kernel.isPluginActive('acme.owner')).toBe(true);
    expect(kernel.isPluginActive('acme.duplicate')).toBe(false);
    expect(kernel.getPluginStatuses().find((p) => p.id === 'acme.duplicate')?.error).toMatch(
      /already registered/,
    );

    // defaultPosition and defaultDock stay normalized in sync
    expect(kernel.getViewportDescriptor('shared.vp')?.defaultPosition).toBe('bottom');
    expect(kernel.getViewportDescriptor('shared.vp')?.defaultDock).toBe('bottom');
    expect(kernel.getViewportDescriptor('alpha.vp')?.defaultPosition).toBe('left-drawer');
    expect(kernel.getViewportDescriptor('alpha.vp')?.defaultDock).toBe('left-drawer');

    // Settings pages are ordered and inherit plugin icon fallback
    expect(kernel.getSettingsPages().map((p) => p.title)).toEqual([
      'Alpha Settings',
      'Zeta Settings',
    ]);
    expect(kernel.getSettingsPages()[1]?.icon).toBe(DummyIcon);
    expect(activatedSpy).toHaveBeenCalledWith('acme.owner');
    expect(activatedSpy).toHaveBeenCalledWith('acme.alpha');

    // Disabling acme.owner removes its settings page cleanly
    await kernel.disablePlugin('acme.owner');
    expect(kernel.getSettingsPages().map((p) => p.id)).toEqual(['alpha-cfg']);

    // Plugin config update, persistence, reset, and external localStorage.clear() detection
    const defaults = { interval: 2500, showBanner: true };
    expect(kernel.getPluginConfig('acme.alpha', defaults)).toEqual(defaults);

    await kernel.updatePluginConfig('acme.alpha', { interval: 5000 });
    expect(kernel.getPluginConfig('acme.alpha', defaults)).toEqual({
      interval: 5000,
      showBanner: true,
    });
    expect(
      JSON.parse(window.localStorage.getItem('lighterm:plugin-config:acme.alpha') ?? 'null'),
    ).toEqual({ interval: 5000 });

    window.localStorage.clear();
    expect(kernel.getPluginConfig('acme.alpha', defaults)).toEqual(defaults);

    await kernel.updatePluginConfig('acme.alpha', { showBanner: false });
    await kernel.resetPluginConfig('acme.alpha', defaults);
    expect(kernel.getPluginConfig('acme.alpha', defaults)).toEqual(defaults);
    expect(window.localStorage.getItem('lighterm:plugin-config:acme.alpha')).toBeNull();
  });
});
