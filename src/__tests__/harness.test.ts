import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HarnessKernel } from '../harness/HarnessKernel';
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
});
