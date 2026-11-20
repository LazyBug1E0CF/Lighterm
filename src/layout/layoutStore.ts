import { create } from 'zustand';
import { makeUuid } from '../core/ipc';
import { harnessKernel } from '../harness/HarnessKernel';
import {
  collectGroups,
  dockViewportAtEdge,
  dockViewportInGroup,
  findGroupContainingViewport,
  removeViewportFromTree,
  setActiveViewportInGroup,
  setActiveViewportInTree,
  updateDockSplitRatio,
} from './dockTree';
import type {
  DockEdge,
  DockNode,
  DockZone,
  FloatingRect,
  FloatingViewportItem,
  OpenViewportOptions,
  SnapTarget,
  ViewportDragState,
  ViewportInstance,
} from './types';

export interface LayoutStoreState {
  viewports: Record<string, ViewportInstance>;
  dockRoot: DockNode | null;
  floating: FloatingViewportItem[];
  activeViewportId: string | null;
  maximizedViewportId: string | null;
  dragState: ViewportDragState | null;
  topZIndex: number;
  workspaceBounds: { width: number; height: number };
}

const MIN_FLOAT_W = 280;
const MIN_FLOAT_H = 180;

function clampFloatRect(
  rect: Partial<FloatingRect>,
  bounds: { width: number; height: number },
  staggerIdx = 0,
): FloatingRect {
  const maxW = Math.max(MIN_FLOAT_W, bounds.width - 24);
  const maxH = Math.max(MIN_FLOAT_H, bounds.height - 24);
  const width = Math.min(maxW, Math.max(MIN_FLOAT_W, rect.width ?? 520));
  const height = Math.min(maxH, Math.max(MIN_FLOAT_H, rect.height ?? 360));
  const defaultX = Math.max(16, Math.round((bounds.width - width) / 2) + staggerIdx * 24);
  const defaultY = Math.max(16, Math.round((bounds.height - height) / 2) + staggerIdx * 20);
  const x = Math.max(0, Math.min(Math.max(0, bounds.width - 120), rect.x ?? defaultX));
  const y = Math.max(0, Math.min(Math.max(0, bounds.height - 60), rect.y ?? defaultY));
  return { x, y, width, height };
}

export const useLayoutStore = create<LayoutStoreState>(() => ({
  viewports: {},
  dockRoot: null,
  floating: [],
  activeViewportId: null,
  maximizedViewportId: null,
  dragState: null,
  topZIndex: 20,
  workspaceBounds: { width: 1200, height: 760 },
}));

export class LayoutService {
  setWorkspaceBounds(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    useLayoutStore.setState({ workspaceBounds: { width, height } });
  }

  getViewport(viewportId: string): ViewportInstance | undefined {
    return useLayoutStore.getState().viewports[viewportId];
  }

  findViewportsByType(typeId: string): ViewportInstance[] {
    return Object.values(useLayoutStore.getState().viewports).filter((v) => v.typeId === typeId);
  }

  updateViewportTitle(viewportId: string, title: string): void {
    const clean = title.trim();
    if (!clean) return;
    useLayoutStore.setState((state) => {
      const existing = state.viewports[viewportId];
      if (!existing) return state;
      return {
        viewports: {
          ...state.viewports,
          [viewportId]: { ...existing, title: clean },
        },
      };
    });
  }

  openViewport(opts: OpenViewportOptions): ViewportInstance {
    const state = useLayoutStore.getState();
    const id = opts.id ?? makeUuid('vp');
    const instance: ViewportInstance = {
      id,
      typeId: opts.typeId,
      pluginId: opts.pluginId,
      title: opts.title,
      params: opts.params,
    };

    const nextViewports = { ...state.viewports, [id]: instance };

    if (opts.preferredDock === 'float') {
      const nextZ = state.topZIndex + 1;
      const rect = clampFloatRect(opts.floatRect ?? {}, state.workspaceBounds, state.floating.length);
      useLayoutStore.setState({
        viewports: nextViewports,
        floating: [...state.floating, { viewportId: id, ...rect, zIndex: nextZ }],
        activeViewportId: id,
        topZIndex: nextZ,
      });
      return instance;
    }

    let nextRoot: DockNode | null = state.dockRoot;

    if (opts.targetGroupId) {
      nextRoot = dockViewportInGroup(
        state.dockRoot,
        id,
        opts.targetGroupId,
        opts.splitZone ?? 'center',
      );
    } else if (opts.preferredDock === 'center' || !opts.preferredDock) {
      const groups = collectGroups(state.dockRoot);
      const sameTypeGroup = groups.find((g) =>
        g.viewportIds.some((vid) => nextViewports[vid]?.typeId === opts.typeId),
      );
      if (sameTypeGroup) {
        nextRoot = dockViewportInGroup(state.dockRoot, id, sameTypeGroup.id, 'center');
      } else if (groups.length === 0) {
        nextRoot = dockViewportAtEdge(null, id, 'left');
      } else {
        const middleGroup = groups[Math.floor(groups.length / 2)];
        const middleIsSidePanel = middleGroup.viewportIds.some((vid) => {
          const vpType = nextViewports[vid]?.typeId;
          return vpType === 'hosts.manager' || vpType === 'monitor.panel';
        });
        if (middleIsSidePanel) {
          const hasRightMonitor = groups.some((g) =>
            g.viewportIds.some((vid) => nextViewports[vid]?.typeId === 'monitor.panel'),
          );
          const hasLeftHosts = groups.some((g) =>
            g.viewportIds.some((vid) => nextViewports[vid]?.typeId === 'hosts.manager'),
          );
          if (hasLeftHosts && hasRightMonitor) {
            const leftGrp = groups[0];
            nextRoot = dockViewportInGroup(state.dockRoot, id, leftGrp.id, 'right', 0.28);
          } else if (hasLeftHosts) {
            nextRoot = dockViewportAtEdge(state.dockRoot, id, 'right', 0.22);
          } else {
            nextRoot = dockViewportAtEdge(state.dockRoot, id, 'left', 0.76);
          }
        } else {
          nextRoot = dockViewportInGroup(state.dockRoot, id, middleGroup.id, 'center');
        }
      }
    } else {
      nextRoot = dockViewportAtEdge(state.dockRoot, id, opts.preferredDock);
    }

    useLayoutStore.setState({
      viewports: nextViewports,
      dockRoot: nextRoot,
      activeViewportId: id,
    });
    return instance;
  }

  toggleSingletonViewport(opts: Omit<OpenViewportOptions, 'id'>): ViewportInstance | null {
    const existing = this.findViewportsByType(opts.typeId)[0];
    if (existing) {
      this.closeViewport(existing.id);
      return null;
    }
    return this.openViewport(opts);
  }

  closeViewport(viewportId: string): void {
    const state = useLayoutStore.getState();
    const existing = state.viewports[viewportId];
    if (!existing) return;

    const desc = harnessKernel.getViewportDescriptor(existing.typeId);
    if (desc?.onClose) {
      try {
        desc.onClose(existing);
      } catch {
        // Ignore plugin close handler errors
      }
    }

    const { [viewportId]: _removed, ...restViewports } = state.viewports;
    const nextRoot = removeViewportFromTree(state.dockRoot, viewportId);
    const nextFloating = state.floating.filter((f) => f.viewportId !== viewportId);

    let nextActive = state.activeViewportId;
    if (nextActive === viewportId) {
      const remainingGroup = collectGroups(nextRoot)[0];
      nextActive =
        remainingGroup?.activeViewportId ??
        nextFloating[nextFloating.length - 1]?.viewportId ??
        null;
    }

    useLayoutStore.setState({
      viewports: restViewports,
      dockRoot: nextRoot,
      floating: nextFloating,
      activeViewportId: nextActive,
      maximizedViewportId:
        state.maximizedViewportId === viewportId ? null : state.maximizedViewportId,
    });
  }

  setActiveViewport(viewportId: string): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const isFloating = state.floating.some((f) => f.viewportId === viewportId);
    let nextZ = state.topZIndex;
    const nextFloating = isFloating
      ? state.floating.map((f) =>
          f.viewportId === viewportId ? { ...f, zIndex: ++nextZ } : f,
        )
      : state.floating;

    useLayoutStore.setState({
      activeViewportId: viewportId,
      dockRoot: setActiveViewportInTree(state.dockRoot, viewportId),
      floating: nextFloating,
      topZIndex: nextZ,
    });
  }

  selectGroupTab(groupId: string, viewportId: string): void {
    useLayoutStore.setState((state) => ({
      dockRoot: setActiveViewportInGroup(state.dockRoot, groupId, viewportId),
      activeViewportId: viewportId,
    }));
  }

  dockToEdge(viewportId: string, edge: DockEdge, ratio?: number): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const nextFloating = state.floating.filter((f) => f.viewportId !== viewportId);
    const nextRoot = dockViewportAtEdge(state.dockRoot, viewportId, edge, ratio);
    useLayoutStore.setState({
      dockRoot: nextRoot,
      floating: nextFloating,
      activeViewportId: viewportId,
      maximizedViewportId: null,
    });
  }

  dockToGroup(viewportId: string, targetGroupId: string, zone: DockZone, ratio = 0.5): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const nextFloating = state.floating.filter((f) => f.viewportId !== viewportId);
    const nextRoot = dockViewportInGroup(state.dockRoot, viewportId, targetGroupId, zone, ratio);
    useLayoutStore.setState({
      dockRoot: nextRoot,
      floating: nextFloating,
      activeViewportId: viewportId,
      maximizedViewportId: null,
    });
  }

  floatViewport(viewportId: string, rect?: Partial<FloatingRect>): void {
    const state = useLayoutStore.getState();
    const vp = state.viewports[viewportId];
    if (!vp) return;

    const desc = harnessKernel.getViewportDescriptor(vp.typeId);
    const existingFloat = state.floating.find((f) => f.viewportId === viewportId);
    const nextZ = state.topZIndex + 1;

    if (existingFloat) {
      const clamped = clampFloatRect({ ...existingFloat, ...rect }, state.workspaceBounds);
      useLayoutStore.setState({
        floating: state.floating.map((f) =>
          f.viewportId === viewportId ? { viewportId, ...clamped, zIndex: nextZ } : f,
        ),
        activeViewportId: viewportId,
        topZIndex: nextZ,
        maximizedViewportId: null,
      });
      return;
    }

    const nextRoot = removeViewportFromTree(state.dockRoot, viewportId);
    const clamped = clampFloatRect(
      {
        width: rect?.width ?? desc?.defaultFloatSize?.width ?? 520,
        height: rect?.height ?? desc?.defaultFloatSize?.height ?? 360,
        x: rect?.x,
        y: rect?.y,
      },
      state.workspaceBounds,
      state.floating.length,
    );

    useLayoutStore.setState({
      dockRoot: nextRoot,
      floating: [...state.floating, { viewportId, ...clamped, zIndex: nextZ }],
      activeViewportId: viewportId,
      topZIndex: nextZ,
      maximizedViewportId: null,
    });
  }

  moveFloating(viewportId: string, x: number, y: number): void {
    useLayoutStore.setState((state) => {
      const clampedX = Math.max(0, Math.min(Math.max(0, state.workspaceBounds.width - 120), x));
      const clampedY = Math.max(0, Math.min(Math.max(0, state.workspaceBounds.height - 60), y));
      return {
        floating: state.floating.map((f) =>
          f.viewportId === viewportId ? { ...f, x: clampedX, y: clampedY } : f,
        ),
      };
    });
  }

  resizeFloating(viewportId: string, rect: FloatingRect): void {
    useLayoutStore.setState((state) => {
      const clamped = clampFloatRect(rect, state.workspaceBounds);
      return {
        floating: state.floating.map((f) =>
          f.viewportId === viewportId ? { ...f, ...clamped } : f,
        ),
      };
    });
  }

  setSplitRatio(splitId: string, ratio: number): void {
    useLayoutStore.setState((state) => ({
      dockRoot: updateDockSplitRatio(state.dockRoot, splitId, ratio),
    }));
  }

  toggleMaximize(viewportId: string): void {
    useLayoutStore.setState((state) => ({
      maximizedViewportId: state.maximizedViewportId === viewportId ? null : viewportId,
      activeViewportId: viewportId,
    }));
  }

  findGroupForViewport(viewportId: string) {
    return findGroupContainingViewport(useLayoutStore.getState().dockRoot, viewportId);
  }

  startDrag(
    viewportId: string,
    source: 'docked' | 'floating',
    startX: number,
    startY: number,
    floatOffsetX = 140,
    floatOffsetY = 16,
  ): void {
    useLayoutStore.setState({
      dragState: {
        viewportId,
        source,
        startX,
        startY,
        currentX: startX,
        currentY: startY,
        active: false,
        floatOffsetX,
        floatOffsetY,
        snapTarget: null,
      },
    });
  }

  updateDrag(currentX: number, currentY: number, snapTarget: SnapTarget | null): void {
    const state = useLayoutStore.getState();
    const drag = state.dragState;
    if (!drag) return;

    const dist = Math.hypot(currentX - drag.startX, currentY - drag.startY);
    const active = drag.active || dist >= 5;

    useLayoutStore.setState({
      dragState: {
        ...drag,
        currentX,
        currentY,
        active,
        snapTarget,
      },
    });

    if (active && drag.source === 'floating') {
      this.moveFloating(drag.viewportId, currentX - drag.floatOffsetX, currentY - drag.floatOffsetY);
    }
  }

  commitDrag(): void {
    const state = useLayoutStore.getState();
    const drag = state.dragState;
    useLayoutStore.setState({ dragState: null });
    if (!drag || !drag.active) return;

    if (drag.snapTarget?.kind === 'edge') {
      this.dockToEdge(drag.viewportId, drag.snapTarget.edge);
      return;
    }

    if (drag.snapTarget?.kind === 'group') {
      this.dockToGroup(drag.viewportId, drag.snapTarget.groupId, drag.snapTarget.zone);
      return;
    }

    if (drag.source === 'docked') {
      this.floatViewport(drag.viewportId, {
        x: Math.max(12, drag.currentX - drag.floatOffsetX),
        y: Math.max(12, drag.currentY - drag.floatOffsetY),
      });
    }
  }

  cancelDrag(): void {
    useLayoutStore.setState({ dragState: null });
  }

  resetLayoutPreservingViewports(): void {
    const state = useLayoutStore.getState();
    const allViewports = Object.values(state.viewports);
    let nextRoot: DockNode | null = null;

    const terminals = allViewports.filter((v) => v.typeId === 'terminal.viewport');
    const hosts = allViewports.filter((v) => v.typeId === 'hosts.manager');
    const monitors = allViewports.filter((v) => v.typeId === 'monitor.panel');
    const others = allViewports.filter(
      (v) =>
        v.typeId !== 'terminal.viewport' &&
        v.typeId !== 'hosts.manager' &&
        v.typeId !== 'monitor.panel',
    );

    for (const term of terminals) {
      if (!nextRoot) {
        nextRoot = dockViewportAtEdge(null, term.id, 'left');
      } else {
        const grp = collectGroups(nextRoot)[0];
        nextRoot = dockViewportInGroup(nextRoot, term.id, grp.id, 'center');
      }
    }
    for (const h of hosts) {
      nextRoot = dockViewportAtEdge(nextRoot, h.id, 'left', 0.21);
    }
    for (const m of monitors) {
      nextRoot = dockViewportAtEdge(nextRoot, m.id, 'right', 0.76);
    }
    for (const o of others) {
      const desc = harnessKernel.getViewportDescriptor(o.typeId);
      const edge =
        desc?.defaultDock === 'left' ||
        desc?.defaultDock === 'right' ||
        desc?.defaultDock === 'top' ||
        desc?.defaultDock === 'bottom'
          ? desc.defaultDock
          : 'bottom';
      nextRoot = dockViewportAtEdge(nextRoot, o.id, edge);
    }

    useLayoutStore.setState({
      dockRoot: nextRoot,
      floating: [],
      maximizedViewportId: null,
    });
  }

  resetForTesting(): void {
    useLayoutStore.setState({
      viewports: {},
      dockRoot: null,
      floating: [],
      activeViewportId: null,
      maximizedViewportId: null,
      dragState: null,
      topZIndex: 20,
      workspaceBounds: { width: 1200, height: 760 },
    });
  }
}

export const layoutService = new LayoutService();
