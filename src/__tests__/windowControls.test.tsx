import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ShellTopBar } from '../components/shell/ShellTopBar';
import { detectPlatformFromEnv, useWindowStore, windowControls } from '../core/windowControls';
import { HarnessProvider } from '../harness/HarnessContext';
import { harnessKernel } from '../harness/HarnessKernel';
import { bootstrapLightermHarness, resetLightermHarnessForTesting } from '../plugins';

describe('Platform-adaptive frameless WindowControls & ShellTopBar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('detects Windows, macOS, and Linux from user agent environment', () => {
    expect(detectPlatformFromEnv('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectPlatformFromEnv('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos');
    expect(detectPlatformFromEnv('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
  });

  it('places Windows controls at the end of ShellTopBar, toggles maximize state, and supports header double-click', () => {
    windowControls.setPlatformForTesting('windows');
    render(
      <HarnessProvider kernel={harnessKernel}>
        <ShellTopBar />
      </HarnessProvider>,
    );

    const header = screen.getByRole('banner');
    const controls = within(header).getByRole('group', { name: 'Window Controls' });
    expect(header.lastElementChild).toBe(controls);

    const labels = Array.from(controls.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Minimize Window', 'Maximize Window', 'Close Window']);

    fireEvent.click(within(controls).getByLabelText('Maximize Window'));
    expect(useWindowStore.getState().maximized).toBe(true);
    expect(within(controls).getByLabelText('Restore Window')).toBeTruthy();

    fireEvent.click(within(controls).getByLabelText('Restore Window'));
    expect(useWindowStore.getState().maximized).toBe(false);

    // Double-clicking a workspace tab must NOT toggle window maximize
    const ws1Tab = within(header).getByRole('tab', { name: /Workspace 1/i });
    fireEvent.mouseDown(ws1Tab, { button: 0, detail: 2 });
    expect(useWindowStore.getState().maximized).toBe(false);

    // Double-clicking empty header drag region toggles maximize
    fireEvent.mouseDown(header, { button: 0, detail: 2 });
    expect(useWindowStore.getState().maximized).toBe(true);
  });

  it('places macOS traffic-light controls at the start of ShellTopBar before the brand badge', () => {
    windowControls.setPlatformForTesting('macos');
    render(
      <HarnessProvider kernel={harnessKernel}>
        <ShellTopBar />
      </HarnessProvider>,
    );

    const header = screen.getByRole('banner');
    const controls = within(header).getByRole('group', { name: 'Window Controls' });
    expect(header.firstElementChild).toBe(controls);

    const labels = Array.from(controls.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['Close Window', 'Minimize Window', 'Maximize Window']);
    expect(screen.getByText('Lighterm')).toBeTruthy();
  });

  it('omits plugin drawer viewport toggle buttons from ShellTopBar while keeping plugins active', async () => {
    await bootstrapLightermHarness();
    render(
      <HarnessProvider kernel={harnessKernel}>
        <ShellTopBar />
      </HarnessProvider>,
    );

    const header = screen.getByRole('banner');
    expect(harnessKernel.isPluginActive('lighterm.hosts')).toBe(true);
    expect(harnessKernel.isPluginActive('lighterm.sftp')).toBe(true);
    expect(within(header).queryByLabelText('SSH Hosts')).toBeNull();
    expect(within(header).queryByLabelText('Snippets')).toBeNull();
    expect(within(header).queryByLabelText('Command History')).toBeNull();
    expect(within(header).queryByLabelText('Toggle SFTP')).toBeNull();
    expect(within(header).queryByLabelText('Toggle System Status')).toBeNull();
  });
});
