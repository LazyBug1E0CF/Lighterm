import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ViewportInstanceRef } from '../harness/types';
import {
  computeCardDisplacementY,
  computeDragTargetIndex,
  measurePanelGap,
  type PanelBaseRect,
} from '../plugins/monitor/monitorDragLayout';
import {
  DEFAULT_MONITOR_PANELS,
  LS_MONITOR_PANELS,
  monitorPanelService,
  movePanelBySlot,
  movePanelToIndex,
  sanitizePanelOrder,
  useMonitorPanelStore,
  type MonitorPanelId,
} from '../plugins/monitor/monitorPanelStore';
import { MonitorViewport } from '../plugins/monitor/MonitorViewport';

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

const MOCK_VIEWPORT: ViewportInstanceRef = {
  id: 'vp-monitor-test',
  typeId: 'monitor.panel',
  pluginId: 'lighterm.monitor',
  title: 'System Status',
};

function renderMonitor() {
  return render(
    <MonitorViewport
      viewport={MOCK_VIEWPORT}
      isActive
      isFloating={false}
      onClose={vi.fn()}
    />,
  );
}

function getRenderedPanelIds(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]')).map(
    (el) => el.dataset.monitorPanelId ?? '',
  );
}

function getPanelEl(container: HTMLElement, id: MonitorPanelId): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-monitor-panel-id="${id}"]`);
  if (!el) throw new Error(`Missing panel element: ${id}`);
  return el;
}

function mockDynamicStackedPanelRects(container: HTMLElement): Record<string, ReturnType<typeof vi.fn>> {
  const animateMocks: Record<string, ReturnType<typeof vi.fn>> = {};
  const cards = container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]');
  cards.forEach((card) => {
    const id = card.dataset.monitorPanelId ?? '';
    const animateMock = vi.fn(() => ({ finish: vi.fn(), cancel: vi.fn() }));
    card.animate = animateMock as unknown as typeof card.animate;
    animateMocks[id] = animateMock;

    vi.spyOn(card, 'getBoundingClientRect').mockImplementation(() => {
      const currentCards = Array.from(
        container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]'),
      );
      const domIdx = Math.max(0, currentCards.indexOf(card));
      const top = domIdx * 100;
      const height = 88;
      return {
        x: 0,
        y: top,
        left: 0,
        top,
        right: 260,
        bottom: top + height,
        width: 260,
        height,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });
  return animateMocks;
}

describe('monitorDragLayout pure math', () => {
  it('measures panel gap from static rects with fallback', () => {
    const rects: PanelBaseRect[] = [
      { id: 'host', top: 0, bottom: 88, height: 88 },
      { id: 'cpu', top: 100, bottom: 188, height: 88 },
    ];
    expect(measurePanelGap(rects)).toBe(12);
    expect(measurePanelGap([rects[0]], 14)).toBe(14);
  });

  it('computes non-oscillating target indices and exact displacements for mixed-height panels', () => {
    const variableRects: PanelBaseRect[] = [
      { id: 'host', top: 0, bottom: 100, height: 100 },
      { id: 'cpu', top: 112, bottom: 172, height: 60 },
      { id: 'memory', top: 184, bottom: 324, height: 140 },
      { id: 'network', top: 336, bottom: 416, height: 80 },
    ];
    const gap = measurePanelGap(variableRects);
    expect(gap).toBe(12);

    // Dragging tall host (fromIndex=0, h=100) downward:
    // candidate centers: k=0 -> 50, k=1 -> 122, k=2 -> 274, k=3 -> 366
    expect(computeDragTargetIndex(variableRects, 0, 50, gap)).toBe(0);
    expect(computeDragTargetIndex(variableRects, 0, 120, gap)).toBe(1);
    expect(computeDragTargetIndex(variableRects, 0, 270, gap)).toBe(2);
    expect(computeDragTargetIndex(variableRects, 0, 380, gap)).toBe(3);

    // Exact pixel displacements when host (0) previews moving to index 2:
    // host placeholder moves by +(60+12) + (140+12) = +224
    // cpu (1) and memory (2) move up by -(100+12) = -112
    // network (3) stays put (0)
    expect(computeCardDisplacementY(variableRects, 0, 2, 0, gap)).toBe(224);
    expect(computeCardDisplacementY(variableRects, 0, 2, 1, gap)).toBe(-112);
    expect(computeCardDisplacementY(variableRects, 0, 2, 2, gap)).toBe(-112);
    expect(computeCardDisplacementY(variableRects, 0, 2, 3, gap)).toBe(0);

    // Dragging tall memory (fromIndex=2, h=140) upward to index 0:
    // memory placeholder moves by -((100+12) + (60+12)) = -184
    // host (0) and cpu (1) move down by +(140+12) = +152
    // network (3) stays put (0)
    expect(computeDragTargetIndex(variableRects, 2, 70, gap)).toBe(0);
    expect(computeCardDisplacementY(variableRects, 2, 0, 2, gap)).toBe(-184);
    expect(computeCardDisplacementY(variableRects, 2, 0, 0, gap)).toBe(152);
    expect(computeCardDisplacementY(variableRects, 2, 0, 1, gap)).toBe(152);
    expect(computeCardDisplacementY(variableRects, 2, 0, 3, gap)).toBe(0);

    // No-op returns 0 for all cards
    expect(computeCardDisplacementY(variableRects, 1, 1, 0, gap)).toBe(0);
    expect(computeCardDisplacementY(variableRects, 1, 1, 1, gap)).toBe(0);
  });
});

describe('monitorPanelStore & pure helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
    monitorPanelService.resetForTesting();
  });

  it('sanitizes persisted orders while preserving intentional empty lists', () => {
    expect(sanitizePanelOrder(null)).toEqual([...DEFAULT_MONITOR_PANELS]);
    expect(sanitizePanelOrder('invalid')).toEqual([...DEFAULT_MONITOR_PANELS]);
    expect(sanitizePanelOrder(['cpu', 'unknown', 'cpu', 'network', 123])).toEqual([
      'cpu',
      'network',
    ]);
    expect(sanitizePanelOrder([])).toEqual([]);
  });

  it('reorders panels via movePanelBySlot and movePanelToIndex with clamping and no-ops', () => {
    const base: MonitorPanelId[] = ['host', 'cpu', 'memory', 'network'];

    // Forward move: host (0) dropped at slot 3 -> after memory
    expect(movePanelBySlot(base, 'host', 3)).toEqual(['cpu', 'memory', 'host', 'network']);

    // Backward move: network (3) dropped at slot 1 -> before cpu
    expect(movePanelBySlot(base, 'network', 1)).toEqual(['host', 'network', 'cpu', 'memory']);

    // Clamping out-of-bounds slots
    expect(movePanelBySlot(base, 'network', -5)).toEqual(['network', 'host', 'cpu', 'memory']);
    expect(movePanelBySlot(base, 'host', 99)).toEqual(['cpu', 'memory', 'network', 'host']);

    // No-op slots (before/after current position) return exact same array reference
    expect(movePanelBySlot(base, 'cpu', 1)).toBe(base);
    expect(movePanelBySlot(base, 'cpu', 2)).toBe(base);

    // Direct target index moves
    expect(movePanelToIndex(base, 'host', 2)).toEqual(['cpu', 'memory', 'host', 'network']);
    expect(movePanelToIndex(base, 'network', 0)).toEqual(['network', 'host', 'cpu', 'memory']);
    expect(movePanelToIndex(base, 'host', 99)).toEqual(['cpu', 'memory', 'network', 'host']);
    expect(movePanelToIndex(base, 'network', -3)).toEqual(['network', 'host', 'cpu', 'memory']);
    expect(movePanelToIndex(base, 'cpu', 1)).toBe(base);
  });

  it('supports adding, deleting, reordering, adding all, and resetting with localStorage persistence', () => {
    expect(monitorPanelService.getPanels()).toEqual([...DEFAULT_MONITOR_PANELS]);

    monitorPanelService.removePanel('cpu');
    monitorPanelService.removePanel('disks');
    expect(monitorPanelService.getPanels()).toEqual(['host', 'memory', 'network', 'processes']);
    expect(JSON.parse(window.localStorage.getItem(LS_MONITOR_PANELS) ?? 'null')).toEqual([
      'host',
      'memory',
      'network',
      'processes',
    ]);

    // Adding an existing panel does not duplicate
    monitorPanelService.addPanel('host');
    expect(monitorPanelService.getPanels()).toEqual(['host', 'memory', 'network', 'processes']);

    // Adding at a specific index
    monitorPanelService.addPanel('cpu', 1);
    expect(monitorPanelService.getPanels()).toEqual([
      'host',
      'cpu',
      'memory',
      'network',
      'processes',
    ]);

    // Moving by delta & index
    monitorPanelService.movePanelByDelta('host', 1);
    expect(monitorPanelService.getPanels()).toEqual([
      'cpu',
      'host',
      'memory',
      'network',
      'processes',
    ]);
    monitorPanelService.movePanelByDelta('cpu', -1); // no-op at boundary
    expect(monitorPanelService.getPanels()[0]).toBe('cpu');

    monitorPanelService.movePanelToIndex('processes', 0);
    expect(monitorPanelService.getPanels()).toEqual([
      'processes',
      'cpu',
      'host',
      'memory',
      'network',
    ]);

    // Add all missing panels appends to end preserving custom order
    monitorPanelService.addAllPanels();
    expect(monitorPanelService.getPanels()).toEqual([
      'processes',
      'cpu',
      'host',
      'memory',
      'network',
      'disks',
    ]);

    // Reset restores default order
    monitorPanelService.resetPanels();
    expect(useMonitorPanelStore.getState().panels).toEqual([...DEFAULT_MONITOR_PANELS]);
  });
});

describe('MonitorViewport interactive panel management', () => {
  beforeEach(() => {
    window.localStorage.clear();
    monitorPanelService.resetForTesting();
  });

  it('renders all 6 default status panels in default order with hover-only close buttons and no 6-dot grip icon', async () => {
    const { container } = renderMonitor();

    expect(await screen.findByText('lighterm-local')).toBeTruthy();
    expect(getRenderedPanelIds(container)).toEqual([
      'host',
      'cpu',
      'memory',
      'network',
      'disks',
      'processes',
    ]);

    expect(container.querySelector('.lucide-grip-vertical')).toBeNull();
    const removeCpuBtn = screen.getByLabelText('Remove CPU Panel');
    expect(removeCpuBtn.className).toContain('hidden');
    expect(removeCpuBtn.className).toContain('group-hover:inline-flex');
  });

  it('deletes a panel, shows it as addable in the Add menu, and adds it back', async () => {
    const { container } = renderMonitor();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove CPU Panel'));
    expect(screen.queryByLabelText('CPU Status Panel')).toBeNull();
    expect(getRenderedPanelIds(container)).toEqual([
      'host',
      'memory',
      'network',
      'disks',
      'processes',
    ]);

    // Open Add Status Panel menu
    fireEvent.click(screen.getByLabelText('Add Status Panel'));
    const menu = await screen.findByRole('menu', { name: 'Add Status Panel Menu' });

    const hostItem = within(menu).getByRole('menuitem', { name: /Host Overview/i });
    const cpuItem = within(menu).getByRole('menuitem', { name: /^CPU$/i });
    expect((hostItem as HTMLButtonElement).disabled).toBe(true);
    expect((cpuItem as HTMLButtonElement).disabled).toBe(false);

    // Click CPU to re-add it
    fireEvent.click(cpuItem);
    await waitFor(() => {
      expect(screen.getByLabelText('CPU Status Panel')).toBeTruthy();
    });
    expect(getRenderedPanelIds(container)).toEqual([
      'host',
      'memory',
      'network',
      'disks',
      'processes',
      'cpu',
    ]);

    // Delete two panels and use Add All Panels
    fireEvent.click(screen.getByLabelText('Remove Disks Panel'));
    fireEvent.click(screen.getByLabelText('Remove Network Panel'));
    fireEvent.click(screen.getByLabelText('Add Status Panel'));
    const menu2 = await screen.findByRole('menu', { name: 'Add Status Panel Menu' });
    fireEvent.click(within(menu2).getByRole('menuitem', { name: /Add All Panels/i }));

    expect(getRenderedPanelIds(container)).toEqual([
      'host',
      'memory',
      'processes',
      'cpu',
      'network',
      'disks',
    ]);
  });

  it('shows empty state when all panels are deleted, persists across reload, and restores defaults', async () => {
    const { container, unmount } = renderMonitor();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    const removeLabels = [
      'Remove Host Overview Panel',
      'Remove CPU Panel',
      'Remove Memory & Swap Panel',
      'Remove Network Panel',
      'Remove Disks Panel',
      'Remove Top Processes Panel',
    ];
    for (const label of removeLabels) {
      fireEvent.click(screen.getByLabelText(label));
    }

    expect(getRenderedPanelIds(container)).toEqual([]);
    expect(screen.getByText('No status panels visible')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(LS_MONITOR_PANELS) ?? 'null')).toEqual([]);

    // Remount and reload from storage -> stays empty
    unmount();
    monitorPanelService.reloadFromStorage();
    renderMonitor();
    expect(screen.getByText('No status panels visible')).toBeTruthy();

    // Restore defaults via empty-state action button
    fireEvent.click(screen.getByRole('button', { name: /Restore Defaults/i }));
    expect(await screen.findByText('lighterm-local')).toBeTruthy();
    expect(screen.getByLabelText('CPU Status Panel')).toBeTruthy();
    expect(monitorPanelService.getPanels()).toEqual([...DEFAULT_MONITOR_PANELS]);
  });

  it('renders translucent ghost, immediately animates displaced siblings during drag, settles with FLIP, and persists', async () => {
    const { container, unmount } = renderMonitor();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();

    const animateMocks = mockDynamicStackedPanelRects(container);

    const hostHeaderDragHandle = screen.getByLabelText('Drag to reorder Host Overview Panel');
    fireEvent.pointerDown(hostHeaderDragHandle, { button: 0, clientX: 24, clientY: 20 });

    // Move > 5px down to align ghost with Memory (index 2: top 200) -> clientY = 220
    fireEvent.pointerMove(window, { clientX: 24, clientY: 220 });

    // 1) Translucent ghost of Host Overview panel follows cursor at grabbed offset & card width
    const ghostEl = container.querySelector<HTMLElement>('[data-monitor-drag-ghost="host"]');
    expect(ghostEl).toBeTruthy();
    expect(ghostEl?.getAttribute('aria-hidden')).toBe('true');
    expect(ghostEl?.style.opacity).toBe('0.72');
    expect(ghostEl?.style.left).toBe('0px');
    expect(ghostEl?.style.top).toBe('200px');
    expect(ghostEl?.style.width).toBe('260px');
    expect(within(ghostEl!).getByText('lighterm-local')).toBeTruthy();
    expect(ghostEl?.querySelector('.lucide-grip-vertical')).toBeNull();
    expect(ghostEl?.querySelector('.lucide-x')).toBeNull();

    // 2) Original slot becomes dashed placeholder shifted smoothly to target index (index 2: +200px)
    const hostPlaceholder = getPanelEl(container, 'host');
    expect(hostPlaceholder.dataset.panelPlaceholder).toBe('true');
    expect(hostPlaceholder.style.height).toBe('88px');
    expect(hostPlaceholder.style.transform).toBe('translate3d(0, 200px, 0)');
    expect(hostPlaceholder.style.transition).toContain('transform 200ms');

    // 3) Affected sibling panels (cpu, memory) immediately shift upward with smooth transform transition BEFORE pointerUp
    const cpuEl = getPanelEl(container, 'cpu');
    const memoryEl = getPanelEl(container, 'memory');
    const networkEl = getPanelEl(container, 'network');
    expect(cpuEl.dataset.panelDisplaced).toBe('true');
    expect(cpuEl.style.transform).toBe('translate3d(0, -100px, 0)');
    expect(cpuEl.style.transition).toContain('transform 200ms');
    expect(memoryEl.dataset.panelDisplaced).toBe('true');
    expect(memoryEl.style.transform).toBe('translate3d(0, -100px, 0)');
    expect(networkEl.dataset.panelDisplaced).toBe('false');
    expect(networkEl.style.transform).toBe('translate3d(0, 0px, 0)');

    // 4) Moving pointer back up immediately slides siblings back into resting position
    fireEvent.pointerMove(window, { clientX: 24, clientY: 25 });
    expect(cpuEl.dataset.panelDisplaced).toBe('false');
    expect(cpuEl.style.transform).toBe('translate3d(0, 0px, 0)');
    expect(memoryEl.dataset.panelDisplaced).toBe('false');

    // Move back down to Memory slot and release
    fireEvent.pointerMove(window, { clientX: 24, clientY: 220 });
    fireEvent.pointerUp(window, { clientX: 24, clientY: 220 });

    // Ghost & placeholder gone, inline drag transforms cleared, settle FLIP animation triggered
    expect(container.querySelector('[data-monitor-drag-ghost]')).toBeNull();
    expect(container.querySelector('[data-panel-placeholder="true"]')).toBeNull();
    expect(getPanelEl(container, 'cpu').style.transform).toBe('');
    expect(getPanelEl(container, 'cpu').style.transition).toBe('');
    expect(animateMocks.host).toHaveBeenCalledTimes(1);

    const expectedOrder = ['cpu', 'memory', 'host', 'network', 'disks', 'processes'];
    expect(getRenderedPanelIds(container)).toEqual(expectedOrder);
    expect(JSON.parse(window.localStorage.getItem(LS_MONITOR_PANELS) ?? 'null')).toEqual(
      expectedOrder,
    );

    // Remount -> persisted order remains
    unmount();
    monitorPanelService.reloadFromStorage();
    const remounted = renderMonitor();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();
    expect(getRenderedPanelIds(remounted.container)).toEqual(expectedOrder);

    // Reset Default Layout from Add Status Panel menu restores original order
    fireEvent.click(screen.getByLabelText('Add Status Panel'));
    const menu = await screen.findByRole('menu', { name: 'Add Status Panel Menu' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Reset Default Layout/i }));
    expect(getRenderedPanelIds(remounted.container)).toEqual([...DEFAULT_MONITOR_PANELS]);
  });

  it('ignores sub-threshold moves, cancels drag with settle animation on Escape, and stops pointer propagation', async () => {
    const parentPointerDown = vi.fn();
    const { container } = render(
      <div onPointerDown={parentPointerDown}>
        <MonitorViewport
          viewport={MOCK_VIEWPORT}
          isActive
          isFloating={false}
          onClose={vi.fn()}
        />
      </div>,
    );
    expect(await screen.findByText('lighterm-local')).toBeTruthy();
    const animateMocks = mockDynamicStackedPanelRects(container);

    const cpuHandle = screen.getByLabelText('Drag to reorder CPU Panel');

    // Sub-threshold (<5px) click does not activate ghost or reorder, and stops propagation to parent
    fireEvent.pointerDown(cpuHandle, { button: 0, clientX: 20, clientY: 120 });
    expect(parentPointerDown).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 21, clientY: 122 });
    expect(container.querySelector('[data-monitor-drag-ghost]')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 21, clientY: 122 });
    expect(getRenderedPanelIds(container)).toEqual([...DEFAULT_MONITOR_PANELS]);

    // Active drag cancelled with Escape restores order and triggers settle animation
    fireEvent.pointerDown(cpuHandle, { button: 0, clientX: 20, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 20, clientY: 320 });
    expect(container.querySelector('[data-monitor-drag-ghost="cpu"]')).toBeTruthy();
    expect(getPanelEl(container, 'memory').dataset.panelDisplaced).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-monitor-drag-ghost]')).toBeNull();
    expect(animateMocks.cpu).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { clientX: 20, clientY: 320 });
    expect(getRenderedPanelIds(container)).toEqual([...DEFAULT_MONITOR_PANELS]);

    // Clicking MEM sort button inside Top Processes header does not trigger drag
    const memBtn = screen.getByRole('button', { name: 'MEM' });
    fireEvent.pointerDown(memBtn, { button: 0, clientX: 200, clientY: 520 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 10 });
    expect(container.querySelector('[data-monitor-drag-ghost]')).toBeNull();
    fireEvent.pointerUp(window, { clientX: 200, clientY: 10 });
    expect(getRenderedPanelIds(container)).toEqual([...DEFAULT_MONITOR_PANELS]);
  });

  it('supports keyboard reordering via ArrowUp and ArrowDown with FLIP animation', async () => {
    const { container } = renderMonitor();
    expect(await screen.findByText('lighterm-local')).toBeTruthy();
    const animateMocks = mockDynamicStackedPanelRects(container);

    const hostHandle = screen.getByLabelText('Drag to reorder Host Overview Panel');
    fireEvent.keyDown(hostHandle, { key: 'ArrowDown' });
    expect(getRenderedPanelIds(container)).toEqual([
      'cpu',
      'host',
      'memory',
      'network',
      'disks',
      'processes',
    ]);
    expect(animateMocks.host).toHaveBeenCalledTimes(1);
    expect(animateMocks.cpu).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(hostHandle, { key: 'ArrowUp' });
    expect(getRenderedPanelIds(container)).toEqual([...DEFAULT_MONITOR_PANELS]);
    expect(animateMocks.host).toHaveBeenCalledTimes(2);
    expect(animateMocks.cpu).toHaveBeenCalledTimes(2);
  });
});
