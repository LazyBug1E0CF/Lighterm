import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Puzzle } from 'lucide-react';
import { App } from '../App';
import { shellService, useShellStore } from '../core/shellService';
import {
  definePlugin,
  harnessKernel,
  usePluginConfig,
  type PluginSettingsPageProps,
  type ViewportComponentProps,
} from '../harness';
import { collectGroups, findGroupContainingViewport } from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { bootstrapLightermHarness, resetLightermHarnessForTesting } from '../plugins';
import { HOSTS_VIEWPORT_TYPE } from '../plugins/hosts';
import { MONITOR_VIEWPORT_TYPE } from '../plugins/monitor';
import { useSftpPluginStore } from '../plugins/sftp/sftpClient';

const DummyViewport: React.FC<ViewportComponentProps> = ({ viewport }) => (
  <div data-testid={`dummy-vp-${viewport.typeId}`}>{viewport.title}</div>
);

const CUSTOM_CONFIG_DEFAULTS = { greeting: 'hello', retryCount: 3 };

const CustomSettingsView: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig } = usePluginConfig(pluginId, CUSTOM_CONFIG_DEFAULTS);
  return (
    <div>
      <span data-testid="custom-greeting-val">{config.greeting}</span>
      <button
        type="button"
        onClick={() => void updateConfig({ greeting: 'updated' })}
      >
        Update Custom Config
      </button>
    </div>
  );
};

describe('Standardized Plugin System, Settings Plugins Section & Default Viewport Positions', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('places viewports at registered defaultPosition (left-drawer, right-drawer, bottom, float), preserves bottom split, and resets layout cleanly', async () => {
    await bootstrapLightermHarness();

    act(() => {
      harnessKernel.register(
        definePlugin({
          id: 'acme.bottom-logs',
          name: 'Bottom Logs',
          version: '1.0.0',
          description: 'Bottom log stream plugin',
          icon: Puzzle,
          inject: ['core:layout'],
          activate(ctx) {
            ctx.registerViewport({
              typeId: 'acme.bottom-logs.panel',
              title: 'Bottom Logs',
              icon: Puzzle,
              defaultPosition: 'bottom',
              defaultDockRatio: 0.72,
              singleton: true,
              order: 40,
              component: DummyViewport,
            });
          },
        }),
      );

      harnessKernel.register(
        definePlugin({
          id: 'acme.float-calc',
          name: 'Floating Calculator',
          version: '1.0.0',
          description: 'Floating utility window',
          icon: Puzzle,
          inject: ['core:layout'],
          activate(ctx) {
            ctx.registerViewport({
              typeId: 'acme.float-calc.win',
              title: 'Calculator',
              icon: Puzzle,
              defaultPosition: 'float',
              defaultFloatSize: { width: 420, height: 280 },
              singleton: true,
              order: 50,
              component: DummyViewport,
            });
          },
        }),
      );
    });

    // Opening via toggleSingletonViewport / openPluginViewport honors defaultPosition & size/ratio
    let bottomVpId = '';
    let floatVpId = '';
    act(() => {
      const bottomVp = layoutService.toggleSingletonViewport({ typeId: 'acme.bottom-logs.panel' });
      const floatVp = layoutService.openPluginViewport('acme.float-calc.win');
      bottomVpId = bottomVp!.id;
      floatVpId = floatVp!.id;
    });

    expect(layoutService.getViewportLocation(bottomVpId)).toBe('docked');
    expect(layoutService.getViewportLocation(floatVpId)).toBe('floating');
    const floatRect = useLayoutStore.getState().floating.find((f) => f.viewportId === floatVpId);
    expect(floatRect?.width).toBe(420);
    expect(floatRect?.height).toBe(280);
    const rootAfterBottom = useLayoutStore.getState().dockRoot;
    expect(rootAfterBottom?.type).toBe('split');
    if (rootAfterBottom?.type === 'split') {
      expect(rootAfterBottom.direction).toBe('vertical');
      expect(rootAfterBottom.ratio).toBeCloseTo(0.72, 2);
    }

    // Move viewports away from their defaults, then reset layout -> each returns to its defaultPosition
    const hostsVp = layoutService.findViewportsByType(HOSTS_VIEWPORT_TYPE)[0];
    const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];

    act(() => {
      layoutService.dockToDrawer(bottomVpId, 'left', true);
      layoutService.dockToEdge(hostsVp.id, 'bottom');
      layoutService.floatViewport(monitorVp.id);
      layoutService.dockToEdge(floatVpId, 'right');
      layoutService.resetLayoutPreservingViewports();
    });

    expect(layoutService.getViewportLocation(hostsVp.id)).toBe('left-drawer');
    expect(layoutService.getViewportLocation(monitorVp.id)).toBe('right-drawer');
    expect(layoutService.getViewportLocation(bottomVpId)).toBe('docked');
    expect(layoutService.getViewportLocation(floatVpId)).toBe('floating');

    // When only a bottom-edge plugin viewport remains in dockRoot, creating a new terminal splits above it instead of tab-merging
    const termVp = layoutService.findWorkspaceViewportsByType('terminal.viewport')[0];
    act(() => {
      layoutService.closeViewport(termVp.id);
    });
    expect(collectGroups(useLayoutStore.getState().dockRoot)).toHaveLength(1);

    await act(async () => {
      await shellService.createLocalSession({ title: 'Fresh Shell' });
    });
    const dockAfterNewTerm = useLayoutStore.getState().dockRoot;
    expect(dockAfterNewTerm?.type).toBe('split');
    if (dockAfterNewTerm?.type === 'split') {
      expect(dockAfterNewTerm.direction).toBe('vertical');
      expect(findGroupContainingViewport(dockAfterNewTerm.second, bottomVpId)).not.toBeNull();
    }
  });

  it('auto-mounts openOnStartup drawer viewport when an initially disabled plugin is enabled at runtime', async () => {
    await bootstrapLightermHarness();

    act(() => {
      harnessKernel.register(
        definePlugin({
          id: 'acme.deferred-drawer',
          name: 'Deferred Drawer Tool',
          version: '1.0.0',
          description: 'Mounts to right-drawer when enabled',
          icon: Puzzle,
          defaultEnabled: false,
          activate(ctx) {
            ctx.registerViewport({
              typeId: 'acme.deferred.panel',
              title: 'Deferred Tool',
              icon: Puzzle,
              defaultPosition: 'right-drawer',
              singleton: true,
              openOnStartup: true,
              order: 25,
              component: DummyViewport,
            });
          },
        }),
      );
    });

    expect(harnessKernel.isPluginActive('acme.deferred-drawer')).toBe(false);
    expect(layoutService.findViewportsByType('acme.deferred.panel')).toHaveLength(0);

    await act(async () => {
      await harnessKernel.enablePlugin('acme.deferred-drawer');
    });

    const mounted = layoutService.findViewportsByType('acme.deferred.panel');
    expect(mounted).toHaveLength(1);
    expect(layoutService.getViewportLocation(mounted[0].id)).toBe('right-drawer');
  });

  it('renders Settings General and Plugins sections, persists plugin settings live, handles disable fallback, and links from Plugin Manager', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.sftp')).toBe(true);
    });

    act(() => {
      harnessKernel.register(
        definePlugin({
          id: 'acme.core-always',
          name: 'Always-On Core Addon',
          version: '1.0.0',
          description: 'Always-on addon whose settings belong in General',
          icon: Puzzle,
          alwaysOn: true,
          activate(ctx) {
            ctx.registerSettingsPage({
              id: 'core-addon',
              title: 'Core Addon',
              order: 15,
              component: CustomSettingsView,
            });
          },
        }),
      );

      harnessKernel.register(
        definePlugin({
          id: 'acme.custom-cfg',
          name: 'Custom Configurable',
          version: '1.0.0',
          description: 'Registers a custom Settings page',
          icon: Puzzle,
          activate(ctx) {
            ctx.registerSettingsPage({
              id: 'custom',
              title: 'Custom Plugin',
              description: 'Custom plugin settings description.',
              order: 60,
              component: CustomSettingsView,
            });
          },
        }),
      );
    });

    // Open Settings and inspect General (core + alwaysOn) vs Plugins (optional) navigation sections
    fireEvent.click(screen.getByLabelText('Settings'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });

    const nav = within(dialog).getByRole('navigation', { name: 'Settings Navigation' });
    const generalSection = within(nav).getByRole('group', { name: 'General Settings' });
    const pluginsSection = within(nav).getByRole('group', { name: 'Plugin Settings' });

    const generalButtons = within(generalSection).getAllByRole('button');
    expect(generalButtons.map((b) => b.textContent?.trim())).toEqual([
      'Appearance',
      'Terminal',
      'Core Addon',
      'Command History',
      'Shortcuts',
    ]);

    const pluginButtons = within(pluginsSection).getAllByRole('button');
    expect(pluginButtons.map((b) => b.textContent?.trim())).toEqual([
      'System Status',
      'SFTP Browser',
      'Snippets',
      'Custom Plugin',
    ]);

    // Clicking alwaysOn plugin Terminal inside General renders its settings page
    fireEvent.click(within(generalSection).getByRole('button', { name: 'Terminal' }));
    expect(dialog.querySelector('[data-plugin-settings-header="lighterm.terminal"]')).toBeTruthy();
    expect(within(dialog).getByText('Font Family')).toBeTruthy();

    // Switch to SFTP Browser settings page and verify live config + store update
    fireEvent.click(within(pluginsSection).getByRole('button', { name: 'SFTP Browser' }));
    expect(dialog.querySelector('[data-plugin-settings-header="lighterm.sftp"]')).toBeTruthy();
    const showHiddenCheckbox = within(dialog).getByLabelText(
      'Show hidden files by default',
    ) as HTMLInputElement;
    expect(showHiddenCheckbox.checked).toBe(false);

    fireEvent.click(showHiddenCheckbox);
    await waitFor(() => {
      expect(useSftpPluginStore.getState().showHidden).toBe(true);
      expect(
        JSON.parse(window.localStorage.getItem('lighterm:plugin-config:lighterm.sftp') ?? 'null'),
      ).toMatchObject({ showHiddenByDefault: true });
    });

    // Disabling the currently viewed plugin removes its tab and safely falls back to Appearance
    await act(async () => {
      await harnessKernel.disablePlugin('lighterm.sftp');
    });

    await waitFor(() => {
      expect(within(pluginsSection).queryByRole('button', { name: 'SFTP Browser' })).toBeNull();
      expect(within(dialog).getByText('Color Theme')).toBeTruthy();
    });

    // Re-enabling restores SFTP Browser to Plugins section
    await act(async () => {
      await harnessKernel.enablePlugin('lighterm.sftp');
    });
    expect(await within(pluginsSection).findByRole('button', { name: 'SFTP Browser' })).toBeTruthy();

    // Update Custom Plugin settings page
    fireEvent.click(within(pluginsSection).getByRole('button', { name: 'Custom Plugin' }));
    expect(within(dialog).getByTestId('custom-greeting-val').textContent).toBe('hello');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update Custom Config' }));
    await waitFor(() => {
      expect(within(dialog).getByTestId('custom-greeting-val').textContent).toBe('updated');
    });

    fireEvent.click(within(dialog).getByLabelText('Close Settings'));

    // Open Plugin Manager, dock System Status to Bottom, and jump via Configure to Snippets Settings
    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModal = await screen.findByRole('dialog', { name: 'Plugin Manager' });

    expect(within(pluginModal).getByText('Default: Bottom Panel')).toBeTruthy();
    expect(within(pluginModal).getByLabelText('Command History Always On')).toBeTruthy();
    expect(within(pluginModal).queryByLabelText('Toggle Command History')).toBeNull();

    fireEvent.click(within(pluginModal).getByLabelText('Bottom Dock System Status Panel'));
    await waitFor(() => {
      const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];
      expect(layoutService.getViewportLocation(monitorVp.id)).toBe('docked');
    });

    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModal2 = await screen.findByRole('dialog', { name: 'Plugin Manager' });
    fireEvent.click(within(pluginModal2).getByLabelText('Configure Command Snippets'));

    const settingsReopened = await screen.findByRole('dialog', { name: 'Settings' });
    expect(
      settingsReopened.querySelector('[data-plugin-settings-header="lighterm.snippets"]'),
    ).toBeTruthy();
    expect(within(settingsReopened).getByLabelText('Default Snippet Category')).toBeTruthy();
  }, 15000);
});
