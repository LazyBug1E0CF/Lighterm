import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../App';
import { useAppStore } from '../store/useAppStore';

describe('Lighterm App integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('initializes local tab, splits pane, saves SSH host, views snippets, and switches theme', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useAppStore.getState().initialized).toBe(true);
      expect(useAppStore.getState().tabs.length).toBeGreaterThanOrEqual(1);
    });

    // Open a second local terminal tab
    fireEvent.click(screen.getByLabelText('New Local Terminal'));
    await waitFor(() => {
      expect(useAppStore.getState().tabs.length).toBeGreaterThanOrEqual(2);
    });

    // Split active pane horizontally
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      const state = useAppStore.getState();
      const active = state.tabs.find((t) => t.id === state.activeTabId);
      expect(active?.root.type).toBe('split');
    });

    // Open SSH Host modal and save a new host
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
      expect(useAppStore.getState().hosts.some((h) => h.name === 'Staging API')).toBe(true);
    });

    // Switch sidebar to Snippets and verify starter snippets render
    fireEvent.click(screen.getByLabelText('Snippets'));
    expect(await screen.findByText('Disk Usage (Human)')).toBeTruthy();

    // Open Settings modal and switch theme to Catppuccin Mocha
    fireEvent.click(screen.getByLabelText('Settings'));
    expect(await screen.findByLabelText('Settings', { selector: '[role="dialog"]' })).toBeTruthy();

    fireEvent.click(screen.getByText('Catppuccin Mocha'));
    await waitFor(() => {
      expect(useAppStore.getState().settings.themeId).toBe('catppuccin-mocha');
    });

    // Close Settings modal and verify right-side System Status Panel renders & toggles
    fireEvent.click(screen.getByLabelText('Close Settings'));
    expect(await screen.findByLabelText('System Status Panel')).toBeTruthy();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Toggle System Status'));
    await waitFor(() => {
      expect(useAppStore.getState().monitorOpen).toBe(false);
    });

    fireEvent.click(screen.getByLabelText('Toggle System Status'));
    await waitFor(() => {
      expect(useAppStore.getState().monitorOpen).toBe(true);
    });
  });
});
