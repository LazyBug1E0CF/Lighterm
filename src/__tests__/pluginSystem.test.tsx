import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { MONITOR_VIEWPORT_TYPE, useMonitorPanelStore } from '../plugins/monitor';
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

      harnessKernel.register(
        definePlugin({
          id: 'acme.term-addon',
          name: 'Terminal Addon',
          version: '1.0.0',
          description: 'Mounts collapsible settings panel onto Terminal',
          icon: Puzzle,
          activate(ctx) {
            ctx.registerSettingsPage({
              id: 'addon',
              title: 'Terminal Addon',
              description: 'Optional panel mounted inside Terminal.',
              order: 70,
              mountTo: 'lighterm.terminal:terminal',
              defaultExpanded: false,
              component: CustomSettingsView,
            });
          },
        }),
      );
    });

    // Open Settings and inspect General (core + alwaysOn standalone) vs Plugins (optional standalone) sections
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
      'Shortcuts',
    ]);

    const pluginButtons = within(pluginsSection).getAllByRole('button');
    expect(pluginButtons.map((b) => b.textContent?.trim())).toEqual([
      'System Status',
      'SFTP Browser',
      'Snippets',
      'GitHub Sync',
      'Custom Plugin',
    ]);

    // Clicking Terminal renders TerminalSettingsTab plus mounted collapsible panels (Command History expanded, Terminal Addon collapsed)
    fireEvent.click(within(generalSection).getByRole('button', { name: 'Terminal' }));
    expect(dialog.querySelector('[data-plugin-settings-header="lighterm.terminal"]')).toBeTruthy();
    expect(within(dialog).getByText('Font Family')).toBeTruthy();

    const historyPanel = dialog.querySelector(
      '[data-plugin-settings-panel="lighterm.history"]',
    ) as HTMLElement | null;
    expect(historyPanel).toBeTruthy();
    const historyToggleBtn = historyPanel!.querySelector(
      '[data-plugin-settings-header="lighterm.history"]',
    ) as HTMLButtonElement;
    expect(historyToggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(within(historyPanel!).getByLabelText('Max History Entries Displayed')).toBeTruthy();

    const addonPanel = dialog.querySelector(
      '[data-plugin-settings-panel="acme.term-addon"]',
    ) as HTMLElement | null;
    expect(addonPanel).toBeTruthy();
    const addonToggleBtn = addonPanel!.querySelector(
      '[data-plugin-settings-header="acme.term-addon"]',
    ) as HTMLButtonElement;
    expect(addonToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(within(addonPanel!).queryByTestId('custom-greeting-val')).toBeNull();

    // Expanding collapsed mounted panel shows its settings UI, then collapsing hides it again
    fireEvent.click(addonToggleBtn);
    expect(addonToggleBtn.getAttribute('aria-expanded')).toBe('true');
    expect(within(addonPanel!).getByTestId('custom-greeting-val')).toBeTruthy();
    fireEvent.click(addonToggleBtn);
    expect(addonToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(within(addonPanel!).queryByTestId('custom-greeting-val')).toBeNull();

    // Collapsing Command History panel hides its content cleanly
    fireEvent.click(historyToggleBtn);
    expect(historyToggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(within(historyPanel!).queryByLabelText('Max History Entries Displayed')).toBeNull();

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

    // Deep-linking to a mounted plugin (Configure Command History) opens Terminal Settings with History auto-expanded
    fireEvent.click(within(settingsReopened).getByLabelText('Close Settings'));
    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModal3 = await screen.findByRole('dialog', { name: 'Plugin Manager' });
    fireEvent.click(within(pluginModal3).getByLabelText('Configure Command History'));

    const settingsHistoryDeepLink = await screen.findByRole('dialog', { name: 'Settings' });
    expect(
      settingsHistoryDeepLink.querySelector('[data-plugin-settings-header="lighterm.terminal"]'),
    ).toBeTruthy();
    const deepLinkedHistoryPanel = settingsHistoryDeepLink.querySelector(
      '[data-plugin-settings-panel="lighterm.history"]',
    ) as HTMLElement | null;
    expect(deepLinkedHistoryPanel).toBeTruthy();
    const deepLinkedToggle = deepLinkedHistoryPanel!.querySelector(
      '[data-plugin-settings-header="lighterm.history"]',
    ) as HTMLButtonElement;
    expect(deepLinkedToggle.getAttribute('aria-expanded')).toBe('true');
    expect(
      within(deepLinkedHistoryPanel!).getByLabelText('Max History Entries Displayed'),
    ).toBeTruthy();

    // Clicking the header after deep-linking collapses it cleanly on the first click
    fireEvent.click(deepLinkedToggle);
    expect(deepLinkedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      within(deepLinkedHistoryPanel!).queryByLabelText('Max History Entries Displayed'),
    ).toBeNull();
  }, 15000);

  it('supports multi-viewport plugins and dragging Top Processes out of System Status into Right Drawer and other positions', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(true);
    });

    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    // System Status registers 7 distinct viewports (main dashboard + 6 telemetry sub-viewports)
    const monitorDescriptors = harnessKernel.getPluginViewportDescriptors('lighterm.monitor');
    expect(monitorDescriptors.map((d) => d.typeId)).toEqual([
      'monitor.panel',
      'monitor.host',
      'monitor.cpu',
      'monitor.memory',
      'monitor.network',
      'monitor.disks',
      'monitor.processes',
    ]);

    // Plugin Manager lists multi-viewport badge and collapses sub-viewports by default until expanded
    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModal = await screen.findByRole('dialog', { name: 'Plugin Manager' });
    const monitorCard = pluginModal.querySelector('[data-plugin-card="lighterm.monitor"]') as HTMLElement;
    const monitorVpBadge = within(monitorCard).getByText('7 Viewports');
    expect(monitorVpBadge).toBeTruthy();
    const monitorVpList = monitorCard.querySelector('[data-plugin-viewports="lighterm.monitor"]') as HTMLElement;
    expect(monitorVpList).toBeTruthy();
    const monitorVpToggle = monitorVpList.querySelector(
      '[data-plugin-viewports-toggle="lighterm.monitor"]',
    ) as HTMLButtonElement;
    expect(monitorVpToggle).toBeTruthy();
    expect(monitorVpToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(monitorVpList).queryByLabelText('Right Drawer Viewport Top Processes')).toBeNull();

    // Expanding via the Plugin Viewports header reveals all 7 sub-viewport rows
    fireEvent.click(monitorVpToggle);
    expect(monitorVpToggle.getAttribute('aria-expanded')).toBe('true');
    expect(monitorVpList.querySelectorAll('[data-plugin-viewport-row]')).toHaveLength(7);
    expect(within(monitorVpList).getByLabelText('Right Drawer Viewport Top Processes')).toBeTruthy();

    // Clicking the header again collapses the list
    fireEvent.click(monitorVpToggle);
    expect(monitorVpToggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(monitorVpList).queryByLabelText('Right Drawer Viewport Top Processes')).toBeNull();

    // Clicking the N Viewports badge also expands, and reopening Plugin Manager resets to collapsed
    fireEvent.click(monitorVpBadge);
    expect(monitorVpToggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(monitorVpList).getByLabelText('Right Drawer Viewport Top Processes')).toBeTruthy();
    fireEvent.click(within(pluginModal).getByLabelText('Close Plugin Manager'));

    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModalReopened = await screen.findByRole('dialog', { name: 'Plugin Manager' });
    const reopenedToggle = pluginModalReopened.querySelector(
      '[data-plugin-viewports-toggle="lighterm.monitor"]',
    ) as HTMLButtonElement;
    expect(reopenedToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(pluginModalReopened).getByLabelText('Close Plugin Manager'));

    // SideDrawer Add Viewport (+) menu groups multi-viewport plugins by plugin and collapses them by default
    const rightDrawerContainer = screen.getByLabelText('Right Side Drawer');
    const rightAddBtn = within(rightDrawerContainer).getByLabelText('Add Viewport to Right Drawer');
    fireEvent.click(rightAddBtn);
    const rightAddMenu = await screen.findByLabelText('Add Viewport Menu right');
    expect(within(rightAddMenu).getByRole('menuitem', { name: /SFTP Browser/i })).toBeTruthy();
    expect(within(rightAddMenu).queryByRole('menuitem', { name: /Top Processes/i })).toBeNull();

    const monitorGroupToggle = rightAddMenu.querySelector(
      '[data-add-viewport-group-toggle="lighterm.monitor"]',
    ) as HTMLButtonElement;
    expect(monitorGroupToggle).toBeTruthy();
    expect(monitorGroupToggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(monitorGroupToggle);
    expect(monitorGroupToggle.getAttribute('aria-expanded')).toBe('true');
    const monitorGroupItems = rightAddMenu.querySelector(
      '[data-add-viewport-group-items="lighterm.monitor"]',
    ) as HTMLElement;
    expect(monitorGroupItems).toBeTruthy();
    expect(within(monitorGroupItems).getAllByRole('menuitem')).toHaveLength(7);
    expect(within(monitorGroupItems).getByRole('menuitem', { name: /Top Processes/i })).toBeTruthy();
    expect(within(monitorGroupItems).getByRole('menuitem', { name: /System Status/i })).toBeTruthy();

    // Closing and reopening Add Viewport menu resets plugin group expansion to collapsed
    fireEvent.click(rightAddBtn);
    fireEvent.click(rightAddBtn);
    const rightAddMenuReopened = await screen.findByLabelText('Add Viewport Menu right');
    const reopenedGroupToggle = rightAddMenuReopened.querySelector(
      '[data-add-viewport-group-toggle="lighterm.monitor"]',
    ) as HTMLButtonElement;
    expect(reopenedGroupToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(rightAddBtn);

    // Mock bounding rects & elementsFromPoint (with ancestor data-drop-drawer) to mirror real browser hit-testing
    const monitorAside = screen.getByLabelText('System Status Panel');
    const rightDrawerBox = container.querySelector('[data-drawer-side="right"]') as HTMLElement;
    const rightRail = container.querySelector('[data-activity-rail="right"]') as HTMLElement;
    expect(rightDrawerBox).toBeTruthy();
    expect(rightRail).toBeTruthy();

    monitorAside.getBoundingClientRect = () =>
      ({
        left: 900,
        top: 80,
        right: 1150,
        bottom: 720,
        width: 250,
        height: 640,
        x: 900,
        y: 80,
        toJSON: () => ({}),
      }) as DOMRect;

    rightRail.getBoundingClientRect = () =>
      ({
        left: 1156,
        top: 40,
        right: 1200,
        bottom: 740,
        width: 44,
        height: 700,
        x: 1156,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;

    const cards = Array.from(monitorAside.querySelectorAll<HTMLElement>('[data-monitor-panel-id]'));
    cards.forEach((card, idx) => {
      const top = 120 + idx * 96;
      card.getBoundingClientRect = () =>
        ({
          left: 910,
          top,
          right: 1140,
          bottom: top + 84,
          width: 230,
          height: 84,
          x: 910,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
    });

    const origElementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = vi.fn((x: number, y: number) => {
      if (x >= 900 && x <= 1150 && y >= 80 && y <= 720) {
        return [monitorAside, rightDrawerBox, document.body];
      }
      if (x >= 1156 && x <= 1200 && y >= 40 && y <= 740) {
        return [rightRail, document.body];
      }
      return [document.body];
    });

    try {
      // 1) Internal reorder inside System Status continues to work untouched even when ancestor has data-drop-drawer
      const hostDragHandle = screen.getByLabelText('Drag to reorder Host Overview Panel');
      fireEvent.pointerDown(hostDragHandle, { button: 0, clientX: 960, clientY: 140 });
      fireEvent.pointerMove(window, { clientX: 960, clientY: 340 });

      expect(monitorAside.querySelector('[data-monitor-drag-ghost="host"]')).toBeTruthy();
      expect(container.querySelector('[data-drag-ghost-pill="true"]')).toBeNull();
      expect(useLayoutStore.getState().dragState).toBeNull();

      fireEvent.pointerUp(window, { clientX: 960, clientY: 340 });
      expect(useMonitorPanelStore.getState().panels).toEqual([
        'cpu',
        'memory',
        'host',
        'network',
        'disks',
        'processes',
      ]);
      expect(layoutService.findViewportsByType('monitor.host')).toHaveLength(0);

      // 2) Dragging outside into workspace and back inside System Status cancels external tear-off cleanly
      const procDragHandleReversible = screen.getByLabelText('Drag to reorder Top Processes Panel');
      fireEvent.pointerDown(procDragHandleReversible, { button: 0, clientX: 980, clientY: 610 });
      fireEvent.pointerMove(window, { clientX: 700, clientY: 300 });
      expect(useLayoutStore.getState().dragState?.source).toBe('tear-off');

      fireEvent.pointerMove(window, { clientX: 980, clientY: 590 });
      expect(useLayoutStore.getState().dragState).toBeNull();
      fireEvent.pointerUp(window, { clientX: 980, clientY: 590 });
      expect(layoutService.findViewportsByType('monitor.processes')).toHaveLength(0);
      expect(useMonitorPanelStore.getState().panels).toContain('processes');

      // 3) Dragging "Top Processes" out of System Status onto Right Activity Rail tears it off into Right Drawer
      const procDragHandle = screen.getByLabelText('Drag to reorder Top Processes Panel');
      fireEvent.pointerDown(procDragHandle, { button: 0, clientX: 980, clientY: 610 });
      fireEvent.pointerMove(window, { clientX: 1175, clientY: 200 });

      await waitFor(() => {
        const ghostPill = container.querySelector('[data-drag-ghost-pill="true"]');
        expect(ghostPill?.textContent).toContain('Top Processes');
        expect(monitorAside.querySelector('[data-monitor-drag-ghost="processes"]')).toBeNull();
      });

      fireEvent.pointerUp(window, { clientX: 1175, clientY: 200 });
    } finally {
      document.elementsFromPoint = origElementsFromPoint;
    }

    // Top Processes is now an independent viewport in the Right Drawer, removed from System Status card list
    const rightDrawerAside = screen.getByLabelText('Right Side Drawer');
    await waitFor(() => {
      expect(within(rightDrawerAside).getByLabelText('Switch to Top Processes')).toBeTruthy();
      expect(screen.getByLabelText('Top Processes Viewport')).toBeTruthy();
    });

    const procViewports = layoutService.findViewportsByType('monitor.processes');
    expect(procViewports).toHaveLength(1);
    const procVp = procViewports[0];
    expect(layoutService.getViewportLocation(procVp.id)).toBe('right-drawer');
    expect(useLayoutStore.getState().rightDrawer.activeViewportId).toBe(procVp.id);

    // Same plugin's viewports display different content with different display modes simultaneously:
    // Move Top Processes to bottom split while System Status stays in right-drawer and CPU floats
    act(() => {
      layoutService.dockToEdge(procVp.id, 'bottom', 0.68);
      layoutService.openPluginViewport('monitor.cpu', { preferredDock: 'float' });
    });

    const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];
    const cpuVp = layoutService.findViewportsByType('monitor.cpu')[0];
    expect(layoutService.getViewportLocation(monitorVp.id)).toBe('right-drawer');
    expect(layoutService.getViewportLocation(procVp.id)).toBe('docked');
    expect(layoutService.getViewportLocation(cpuVp.id)).toBe('floating');

    expect(screen.getByLabelText('System Status Panel')).toBeTruthy();
    expect(screen.getByLabelText('Top Processes Viewport')).toBeTruthy();
    expect(screen.getByLabelText('CPU Viewport')).toBeTruthy();

    // Returning Top Processes merges it back into System Status and closes the standalone viewport
    fireEvent.click(screen.getByLabelText('Return Top Processes to System Status'));
    await waitFor(() => {
      expect(layoutService.findViewportsByType('monitor.processes')).toHaveLength(0);
      expect(screen.queryByLabelText('Top Processes Viewport')).toBeNull();
    });

    expect(useLayoutStore.getState().rightDrawer.open).toBe(true);
    expect(useLayoutStore.getState().rightDrawer.activeViewportId).toBe(monitorVp.id);
    expect(await screen.findByLabelText('Top Processes Status Panel')).toBeTruthy();
  }, 15000);
});
