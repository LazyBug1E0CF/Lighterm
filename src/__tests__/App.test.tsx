import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { useShellStore } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import { findGroupContainingViewport } from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { resetLightermHarnessForTesting } from '../plugins';
import { MONITOR_VIEWPORT_TYPE } from '../plugins/monitor';
import { SFTP_VIEWPORT_TYPE } from '../plugins/sftp';

describe('Lighterm Everything-is-a-Plugin & Side Drawers integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('renders collapsible left/right plugin drawers, adds any plugin viewport to drawers, floats/resizes/docks viewports, and toggles plugins live', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(1);
      expect(harnessKernel.isPluginActive('lighterm.terminal')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.hosts')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(true);
    });

    // Verify Left & Right collapsible drawers and rail buttons exist
    const leftDrawerAside = screen.getByLabelText('Left Side Drawer');
    const rightDrawerAside = screen.getByLabelText('Right Side Drawer');
    expect(leftDrawerAside).toBeTruthy();
    expect(rightDrawerAside).toBeTruthy();
    expect(within(leftDrawerAside).getByLabelText('Switch to SSH Hosts')).toBeTruthy();
    expect(within(leftDrawerAside).getByLabelText('Switch to Snippets')).toBeTruthy();
    expect(within(leftDrawerAside).getByLabelText('Switch to Command History')).toBeTruthy();
    expect(within(rightDrawerAside).getByLabelText('Switch to System Status')).toBeTruthy();

    // Open a second local terminal session and split horizontally
    fireEvent.click(screen.getByLabelText('New Local Terminal'));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(3);
    });

    // Add and save an SSH host inside Left Drawer's Hosts viewport
    fireEvent.click(screen.getByLabelText('New SSH Host'));
    expect(await screen.findByLabelText('New SSH Host', { selector: '[role="dialog"]' })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Prod Web 01'), {
      target: { value: 'Staging API' },
    });
    fireEvent.change(screen.getByPlaceholderText('192.168.1.50'), {
      target: { value: '10.10.1.20' },
    });
    fireEvent.change(screen.getByPlaceholderText('ubuntu'), {
      target: { value: 'deploy' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(useShellStore.getState().hosts.some((h) => h.name === 'Staging API')).toBe(true);
    });

    // Switch Left Drawer to Snippets via Left Activity Rail, then collapse & re-expand Left Drawer
    fireEvent.click(within(leftDrawerAside).getByLabelText('Switch to Snippets'));
    expect(await screen.findByText('Disk Usage (Human)')).toBeTruthy();

    fireEvent.click(within(leftDrawerAside).getByLabelText('Collapse Left Drawer'));
    expect(useLayoutStore.getState().leftDrawer.open).toBe(false);
    fireEvent.click(within(leftDrawerAside).getByLabelText('Switch to Snippets'));
    expect(useLayoutStore.getState().leftDrawer.open).toBe(true);

    // Add SFTP Browser into Right Drawer via Right Activity Rail's "+" button
    fireEvent.click(within(rightDrawerAside).getByLabelText('Add Viewport to Right Drawer'));
    const rightAddMenu = await screen.findByLabelText('Add Viewport Menu right');
    fireEvent.click(within(rightAddMenu).getByRole('menuitem', { name: /SFTP Browser/i }));
    expect(await screen.findByLabelText('SFTP File Browser')).toBeTruthy();
    const sftpVp = layoutService.findViewportsByType(SFTP_VIEWPORT_TYPE)[0];
    expect(layoutService.getViewportLocation(sftpVp.id)).toBe('right-drawer');

    // Add a new Terminal viewport into Left Drawer via Left Activity Rail's "+" button
    fireEvent.click(within(leftDrawerAside).getByLabelText('Add Viewport to Left Drawer'));
    const leftAddMenu = await screen.findByLabelText('Add Viewport Menu left');
    fireEvent.click(within(leftAddMenu).getByRole('menuitem', { name: /New Terminal/i }));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(4);
      const drawerTermCount = useLayoutStore
        .getState()
        .leftDrawer.viewportIds.filter(
          (id) => useLayoutStore.getState().viewports[id]?.typeId === 'terminal.viewport',
        ).length;
      expect(drawerTermCount).toBe(1);
    });

    // Open Settings modal and switch theme to Catppuccin Mocha
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(await screen.findByLabelText('Settings', { selector: '[role="dialog"]' })).toBeTruthy();
    fireEvent.click(screen.getByText('Catppuccin Mocha'));
    await waitFor(() => {
      expect(useShellStore.getState().settings.themeId).toBe('catppuccin-mocha');
    });
    fireEvent.click(screen.getByLabelText('Close Settings'));

    // Switch Right Drawer back to System Status, then float, resize, and dock it to bottom
    fireEvent.click(within(rightDrawerAside).getByLabelText('Switch to System Status'));
    expect(await screen.findByLabelText('System Status Panel')).toBeTruthy();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];
    fireEvent.click(within(rightDrawerAside).getByLabelText(`Float ${monitorVp.title}`));

    const floatingEl = await screen.findByLabelText('Floating System Status');
    expect(floatingEl).toBeTruthy();
    expect(useLayoutStore.getState().floating.some((f) => f.viewportId === monitorVp.id)).toBe(true);

    act(() => {
      layoutService.resizeFloating(monitorVp.id, { x: 80, y: 60, width: 420, height: 300 });
    });
    expect(useLayoutStore.getState().floating.find((f) => f.viewportId === monitorVp.id)?.width).toBe(420);

    fireEvent.click(within(floatingEl).getByLabelText('Position Viewport'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dock Bottom' }));

    await waitFor(() => {
      expect(useLayoutStore.getState().floating.some((f) => f.viewportId === monitorVp.id)).toBe(false);
      expect(findGroupContainingViewport(useLayoutStore.getState().dockRoot, monitorVp.id)).not.toBeNull();
    });

    // Open Plugin Manager and live-toggle System Status & Terminal plugins off and back on
    fireEvent.click(screen.getByLabelText('Manage Plugins'));
    const pluginModal = await screen.findByLabelText('Plugin Manager', { selector: '[role="dialog"]' });
    expect(pluginModal).toBeTruthy();

    fireEvent.click(within(pluginModal).getByLabelText('Toggle System Status Panel'));
    await waitFor(() => {
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(false);
      expect(screen.queryByLabelText('System Status Panel')).toBeNull();
    });

    fireEvent.click(within(pluginModal).getByLabelText('Toggle Terminal Viewport'));
    await waitFor(() => {
      expect(harnessKernel.isPluginActive('lighterm.terminal')).toBe(false);
      expect(screen.queryByLabelText('Split Horizontally')).toBeNull();
    });

    fireEvent.click(within(pluginModal).getByLabelText('Toggle Terminal Viewport'));
    fireEvent.click(within(pluginModal).getByLabelText('Toggle System Status Panel'));
    await waitFor(() => {
      expect(harnessKernel.isPluginActive('lighterm.terminal')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(true);
      expect(screen.getByLabelText('Split Horizontally')).toBeTruthy();
    });
  }, 15000);
});
