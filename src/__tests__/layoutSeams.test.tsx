import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { useShellStore } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import {
  registerBuiltinPlugins,
  resetLightermHarnessForTesting,
  terminalPlugin,
} from '../plugins';
import { MONITOR_VIEWPORT_TYPE } from '../plugins/monitor';

beforeAll(() => {
  if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
        this.pointerType = params.pointerType ?? 'mouse';
      }
    }
    window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
    globalThis.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  }
});

describe('Workspace layout seams (zero-gap drawer sashes & 1px split hairlines)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('uses overlay drawer sashes, 1px split dividers, and borderless dock group containers', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(useLayoutStore.getState().leftDrawer.open).toBe(true);
      expect(useLayoutStore.getState().rightDrawer.open).toBe(true);
      expect(layoutService.findViewportsByType('terminal.viewport').length).toBeGreaterThanOrEqual(1);
    });

    // 1) Left and right drawer resize sashes must be zero-footprint absolute overlays
    const leftSash = screen.getByRole('separator', { name: 'Resize Left Drawer' });
    const rightSash = screen.getByRole('separator', { name: 'Resize Right Drawer' });

    expect(leftSash.className.split(' ')).toContain('absolute');
    expect(leftSash.className.split(' ')).toContain('right-0');
    expect(leftSash.className.split(' ')).not.toContain('w-1');

    expect(rightSash.className.split(' ')).toContain('absolute');
    expect(rightSash.className.split(' ')).toContain('left-0');
    expect(rightSash.className.split(' ')).not.toContain('w-1');

    // Dragging the overlay sash still resizes the drawer cleanly
    const initialLeftWidth = useLayoutStore.getState().leftDrawer.width;
    fireEvent.pointerDown(leftSash, { button: 0, clientX: initialLeftWidth + 44, clientY: 200 });
    fireEvent.pointerMove(window, { clientX: initialLeftWidth + 84, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: initialLeftWidth + 84, clientY: 200 });
    expect(useLayoutStore.getState().leftDrawer.width).toBe(initialLeftWidth + 40);

    // 2) Create both horizontal and vertical dock splits (terminals side-by-side + bottom System Status)
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);
    });

    const monitorVp = layoutService.findViewportsByType(MONITOR_VIEWPORT_TYPE)[0];
    expect(monitorVp).toBeTruthy();
    act(() => {
      layoutService.dockToEdge(monitorVp.id, 'bottom');
    });

    await waitFor(() => {
      expect(container.querySelectorAll('[data-group-container]').length).toBe(3);
    });

    // DockGroupView containers have no outer layout border that causes double-border gaps
    const groupContainers = Array.from(
      container.querySelectorAll<HTMLElement>('[data-group-container]'),
    );
    for (const grp of groupContainers) {
      expect(grp.className.split(' ')).not.toContain('border');
    }

    // Split separators use crisp 1px hairlines (w-px / h-px) rather than wide w-1.5 / h-1.5 gaps
    const allSeparators = screen.getAllByRole('separator');
    const verticalSplitSep = allSeparators.find(
      (el) =>
        el.getAttribute('aria-orientation') === 'vertical' &&
        !el.getAttribute('aria-label')?.startsWith('Resize '),
    );
    const horizontalSplitSep = allSeparators.find(
      (el) => el.getAttribute('aria-orientation') === 'horizontal',
    );

    expect(verticalSplitSep).toBeTruthy();
    expect(verticalSplitSep!.className.split(' ')).toContain('w-px');
    expect(verticalSplitSep!.className.split(' ')).not.toContain('w-1.5');

    expect(horizontalSplitSep).toBeTruthy();
    expect(horizontalSplitSep!.className.split(' ')).toContain('h-px');
    expect(horizontalSplitSep!.className.split(' ')).not.toContain('h-1.5');
  }, 15000);

  it('keeps a single tab bar on Terminal when opening bottom SFTP Browser, showing WorkspaceShellToolbar only for multi-terminal splits', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(layoutService.findViewportsByType('terminal.viewport').length).toBeGreaterThanOrEqual(1);
    });

    // Open bottom SFTP Browser via statusbar toggle button
    fireEvent.click(screen.getByRole('button', { name: /SFTP/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('SFTP File Browser')).toBeTruthy();
      expect(container.querySelectorAll('[data-group-container]').length).toBe(2);
    });

    // Single terminal group + bottom SFTP must NOT render WorkspaceShellToolbar (no duplicate Terminal 1 tab row)
    expect(screen.queryByLabelText('Workspace Shell Toolbar')).toBeNull();
    expect(screen.getAllByLabelText('New Local Terminal')).toHaveLength(1);
    expect(screen.getAllByRole('tab', { name: /Terminal 1/i })).toHaveLength(1);

    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-group-container]'));
    const termGroup = groups.find((g) => g.querySelector('[data-viewport-type="terminal.viewport"]'));
    const sftpGroup = groups.find((g) => g.querySelector('[data-viewport-type="sftp.browser"]'));
    expect(termGroup).toBeTruthy();
    expect(sftpGroup).toBeTruthy();
    expect(within(termGroup!).getByLabelText('New Local Terminal')).toBeTruthy();
    expect(within(sftpGroup!).queryByLabelText('New Local Terminal')).toBeNull();

    // Splitting into 2 terminal groups switches controls to WorkspaceShellToolbar without duplicates
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);
    });

    expect(screen.getByLabelText('Workspace Shell Toolbar')).toBeTruthy();
    expect(screen.getAllByLabelText('New Local Terminal')).toHaveLength(1);
  }, 15000);

  it('creates new local shells via both + New Local Shell and + Shell after closing terminals/SFTP and after plugin HMR', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
    });

    // Open SFTP Browser, then close Terminal 1 and SFTP Browser to enter empty workspace state
    fireEvent.click(screen.getByRole('button', { name: /SFTP/i }));
    expect(await screen.findByLabelText('SFTP File Browser')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(0);
    });

    fireEvent.click(screen.getByLabelText('Close SFTP Browser'));
    expect(await screen.findByText(/No central viewports open/i)).toBeTruthy();
    expect(screen.getByLabelText('Create First Local Shell')).toBeTruthy();
    expect(screen.getByLabelText('New Local Terminal')).toBeTruthy();

    // 1) Clicking "+ New Local Shell" opens a new terminal viewport
    fireEvent.click(screen.getByLabelText('Create First Local Shell'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
      expect(screen.queryByText(/No central viewports open/i)).toBeNull();
    });

    // 2) Closing it again and clicking "+ Shell" opens a new terminal viewport
    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    expect(await screen.findByText(/No central viewports open/i)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('New Local Terminal'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
      expect(screen.queryByText(/No central viewports open/i)).toBeNull();
    });

    // 3) Simulate Vite HMR re-evaluating plugins/index.ts & terminal/index.tsx: both buttons must keep working cleanly
    act(() => {
      registerBuiltinPlugins(harnessKernel);
      harnessKernel.register({ ...terminalPlugin });
    });
    expect(harnessKernel.isPluginActive(terminalPlugin.id)).toBe(true);

    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    expect(await screen.findByText(/No central viewports open/i)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Create First Local Shell'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });

    fireEvent.click(screen.getByLabelText('Close Terminal 1'));
    expect(await screen.findByText(/No central viewports open/i)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('New Local Terminal'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
      expect(useShellStore.getState().sessionOrder).toHaveLength(1);
    });
  }, 15000);

  it('keeps terminal DOM and xterm instance mounted without recreation when toggling bottom SFTP or splitting, and resizes via flat split separator', async () => {
    const { container } = render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(1);
    });

    const termViewportEl = container.querySelector<HTMLElement>(
      '[data-viewport-type="terminal.viewport"]',
    );
    const xtermEl = termViewportEl?.querySelector('.xterm');
    expect(termViewportEl).toBeTruthy();
    expect(xtermEl).toBeTruthy();

    // Open bottom SFTP Browser -> Terminal node & xterm instance remain exact same DOM nodes
    const sftpBtn = screen.getByRole('button', { name: /SFTP/i });
    fireEvent.click(sftpBtn);
    await waitFor(() => {
      expect(screen.getByLabelText('SFTP File Browser')).toBeTruthy();
      expect(container.querySelectorAll('[data-group-container]').length).toBe(2);
    });

    expect(container.querySelector('[data-viewport-type="terminal.viewport"]')).toBe(
      termViewportEl,
    );
    expect(termViewportEl!.querySelector('.xterm')).toBe(xtermEl);

    const termSlotEl = termViewportEl!.closest('[data-group-slot]');
    const sftpSlotEl = container
      .querySelector('[data-viewport-type="sftp.browser"]')
      ?.closest('[data-group-slot]');
    expect(termSlotEl?.getAttribute('data-dock-edge')).toBeNull();
    expect(sftpSlotEl?.getAttribute('data-dock-edge')).toBe('bottom');

    // Dragging the flat horizontal split separator updates split ratio cleanly
    const hSep = screen
      .getAllByRole('separator')
      .find((el) => el.getAttribute('aria-orientation') === 'horizontal');
    expect(hSep).toBeTruthy();
    expect(hSep!.getAttribute('data-split-separator-edge')).toBe('bottom');
    const stageEl = hSep!.parentElement!;
    stageEl.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        width: 1000,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.pointerDown(hSep!, { button: 0, clientX: 500, clientY: 340 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 250 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 250 });

    const dockRootAfterResize = useLayoutStore.getState().dockRoot;
    expect(dockRootAfterResize?.type === 'split' && dockRootAfterResize.ratio).toBeCloseTo(0.5, 4);

    // Toggle SFTP Browser closed -> Terminal node & xterm instance STILL remain exact same DOM nodes
    fireEvent.click(sftpBtn);
    await waitFor(() => {
      expect(screen.queryByLabelText('SFTP File Browser')).toBeNull();
      expect(container.querySelectorAll('[data-group-container]').length).toBe(1);
    });

    expect(container.querySelector('[data-viewport-type="terminal.viewport"]')).toBe(
      termViewportEl,
    );
    expect(termViewportEl!.querySelector('.xterm')).toBe(xtermEl);

    // Split Horizontally -> first terminal STILL remains exact same DOM node
    fireEvent.click(screen.getByLabelText('Split Horizontally'));
    await waitFor(() => {
      expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);
    });

    const termEls = Array.from(
      container.querySelectorAll<HTMLElement>('[data-viewport-type="terminal.viewport"]'),
    );
    expect(termEls).toContain(termViewportEl!);
    expect(termViewportEl!.querySelector('.xterm')).toBe(xtermEl);

    const vSep = screen
      .getAllByRole('separator')
      .find(
        (el) =>
          el.getAttribute('aria-orientation') === 'vertical' && !el.getAttribute('aria-label'),
      );
    expect(vSep).toBeTruthy();
    expect(vSep!.getAttribute('data-split-separator-edge')).toBeNull();
  }, 15000);
});
