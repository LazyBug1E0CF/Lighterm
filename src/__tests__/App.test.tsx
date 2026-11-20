import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { useShellStore } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import { findGroupContainingViewport } from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import { resetLightermHarnessForTesting } from '../plugins';
import { MONITOR_VIEWPORT_TYPE } from '../plugins/monitor';

describe('Lighterm Everything-is-a-Plugin App integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('bootstraps plugins, creates & splits terminals, saves SSH host, opens snippets/SFTP, switches theme, floats/resizes/docks viewports, and toggles plugins live', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(1);
      expect(harnessKernel.isPluginActive('lighterm.terminal')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.hosts')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(true);
    });

    // Open a second local terminal session
    fireEvent.click(screen.getByLabelText('New Local Terminal'));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(2);
    });

    // Split active terminal horizontally
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      expect(useShellStore.getState().sessionOrder.length).toBeGreaterThanOrEqual(3);
    });

    // Add and save an SSH host inside Hosts plugin viewport
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

    // Toggle Snippets plugin viewport and verify starter snippets render
    fireEvent.click(screen.getByLabelText('Snippets'));
    expect(await screen.findByText('Disk Usage (Human)')).toBeTruthy();

    // Toggle SFTP plugin viewport
    fireEvent.click(screen.getByLabelText('Toggle SFTP'));
    expect(await screen.findByLabelText('SFTP File Browser')).toBeTruthy();

    // Open Settings modal and switch theme to Catppuccin Mocha
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(await screen.findByLabelText('Settings', { selector: '[role="dialog"]' })).toBeTruthy();

    fireEvent.click(screen.getByText('Catppuccin Mocha'));
    await waitFor(() => {
      expect(useShellStore.getState().settings.themeId).toBe('catppuccin-mocha');
    });
    fireEvent.click(screen.getByLabelText('Close Settings'));

    // Verify System Status Panel renders
    expect(await screen.findByLabelText('System Status Panel')).toBeTruthy();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    // Float the System Status viewport via its Position Viewport menu, resize it, and dock it to bottom
    const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];
    expect(monitorVp).toBeDefined();
    const monitorGroup = findGroupContainingViewport(useLayoutStore.getState().dockRoot, monitorVp.id);
    expect(monitorGroup).not.toBeNull();

    const monitorGroupEl = document.querySelector(`[data-group-container="${monitorGroup!.id}"]`) as HTMLElement;
    expect(monitorGroupEl).toBeTruthy();
    fireEvent.click(within(monitorGroupEl).getByLabelText('Position Viewport'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Float Window' }));

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

    // Re-enable both plugins; viewports and slots remount while Core Shell sessions remain alive
    fireEvent.click(within(pluginModal).getByLabelText('Toggle Terminal Viewport'));
    fireEvent.click(within(pluginModal).getByLabelText('Toggle System Status Panel'));
    await waitFor(() => {
      expect(harnessKernel.isPluginActive('lighterm.terminal')).toBe(true);
      expect(harnessKernel.isPluginActive('lighterm.monitor')).toBe(true);
      expect(screen.getByLabelText('Split Horizontally')).toBeTruthy();
    });
  });
});
