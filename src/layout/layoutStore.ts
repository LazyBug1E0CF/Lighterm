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
  DrawerSide,
  DrawerState,
  FloatingRect,
  FloatingViewportItem,
  OpenViewportOptions,
  SnapTarget,
  ViewportDragState,
  ViewportInstance,
} from './types';

export interface LayoutStoreState {
  viewports: Record<string, ViewportInstance>;
  leftDrawer: DrawerState;
  rightDrawer: DrawerState;
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
const MIN_DRAWER_W = 200;
const MAX_DRAWER_W = 600;

function createInitialLeftDrawer(): DrawerState {
  return { open: true, width: 272, viewportIds: [], activeViewportId: null };
}

function createInitialRightDrawer(): DrawerState {
  return { open: true, width: 288, viewportIds: [], activeViewportId: null };
}

function removeViewportFromDrawer(drawer: DrawerState, viewportId: string): DrawerState {
  if (!drawer.viewportIds.includes(viewportId)) {
    return drawer;
  }
  const idx = drawer.viewportIds.indexOf(viewportId);
  const remaining = drawer.viewportIds.filter((id) => id !== viewportId);
  if (remaining.length === 0) {
    return { ...drawer, open: false, viewportIds: [], activeViewportId: null };
  }
  const nextActive =
    drawer.activeViewportId === viewportId
      ? remaining[Math.min(idx, remaining.length - 1)]
      : drawer.activeViewportId;
  return {
    ...drawer,
    viewportIds: remaining,
    activeViewportId: nextActive,
  };
}

function insertViewportIntoDrawer(
  drawer: DrawerState,
  viewportId: string,
  activate = true,
): DrawerState {
  const nextIds = drawer.viewportIds.includes(viewportId)
    ? drawer.viewportIds
    : [...drawer.viewportIds, viewportId];
  return {
    ...drawer,
    open: activate ? true : drawer.open,
    viewportIds: nextIds,
    activeViewportId: activate || !drawer.activeViewportId ? viewportId : drawer.activeViewportId,
  };
}

function detachViewportEverywhere(
  state: LayoutStoreState,
  viewportId: string,
): Pick<LayoutStoreState, 'dockRoot' | 'floating' | 'leftDrawer' | 'rightDrawer'> {
  return {
    dockRoot: removeViewportFromTree(state.dockRoot, viewportId),
    floating: state.floating.filter((f) => f.viewportId !== viewportId),
    leftDrawer: removeViewportFromDrawer(state.leftDrawer, viewportId),
    rightDrawer: removeViewportFromDrawer(state.rightDrawer, viewportId),
  };
}

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
  leftDrawer: createInitialLeftDrawer(),
  rightDrawer: createInitialRightDrawer(),
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

  getViewportLocation(
    viewportId: string,
  ): 'left-drawer' | 'right-drawer' | 'floating' | 'docked' | null {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return null;
    if (state.leftDrawer.viewportIds.includes(viewportId)) return 'left-drawer';
    if (state.rightDrawer.viewportIds.includes(viewportId)) return 'right-drawer';
    if (state.floating.some((f) => f.viewportId === viewportId)) return 'floating';
    if (findGroupContainingViewport(state.dockRoot, viewportId)) return 'docked';
    return null;
  }

  isViewportOpenOnScreen(typeId: string): boolean {
    const state = useLayoutStore.getState();
    const matches = Object.values(state.viewports).filter((v) => v.typeId === typeId);
    for (const vp of matches) {
      if (state.leftDrawer.viewportIds.includes(vp.id)) {
        if (state.leftDrawer.open && state.leftDrawer.activeViewportId === vp.id) return true;
        continue;
      }
      if (state.rightDrawer.viewportIds.includes(vp.id)) {
        if (state.rightDrawer.open && state.rightDrawer.activeViewportId === vp.id) return true;
        continue;
      }
      if (state.floating.some((f) => f.viewportId === vp.id)) return true;
      if (findGroupContainingViewport(state.dockRoot, vp.id)) return true;
    }
    return false;
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

    if (opts.preferredDock === 'left-drawer' || opts.preferredDock === 'right-drawer') {
      const activate = opts.activateDrawer ?? true;
      const side: DrawerSide = opts.preferredDock === 'left-drawer' ? 'left' : 'right';
      const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
      const nextDrawer = insertViewportIntoDrawer(state[drawerKey], id, activate);
      useLayoutStore.setState({
        viewports: nextViewports,
        [drawerKey]: nextDrawer,
        activeViewportId: activate ? id : state.activeViewportId,
      });
      return instance;
    }

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
        nextRoot = dockViewportInGroup(state.dockRoot, id, middleGroup.id, 'center');
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
      const loc = this.getViewportLocation(existing.id);
      if (loc === 'left-drawer') {
        this.selectDrawerViewport('left', existing.id);
        return existing;
      }
      if (loc === 'right-drawer') {
        this.selectDrawerViewport('right', existing.id);
        return existing;
      }
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
    const detached = detachViewportEverywhere(state, viewportId);

    let nextActive = state.activeViewportId;
    if (nextActive === viewportId) {
      const remainingGroup = collectGroups(detached.dockRoot)[0];
      nextActive =
        remainingGroup?.activeViewportId ??
        detached.floating[detached.floating.length - 1]?.viewportId ??
        detached.leftDrawer.activeViewportId ??
        detached.rightDrawer.activeViewportId ??
        null;
    }

    useLayoutStore.setState({
      viewports: restViewports,
      ...detached,
      activeViewportId: nextActive,
      maximizedViewportId:
        state.maximizedViewportId === viewportId ? null : state.maximizedViewportId,
    });
  }

  setActiveViewport(viewportId: string): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;

    const inLeft = state.leftDrawer.viewportIds.includes(viewportId);
    const inRight = state.rightDrawer.viewportIds.includes(viewportId);
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
      leftDrawer: inLeft
        ? { ...state.leftDrawer, open: true, activeViewportId: viewportId }
        : state.leftDrawer,
      rightDrawer: inRight
        ? { ...state.rightDrawer, open: true, activeViewportId: viewportId }
        : state.rightDrawer,
      topZIndex: nextZ,
    });
  }

  dockToDrawer(viewportId: string, side: DrawerSide, activate = true): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const detached = detachViewportEverywhere(state, viewportId);
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const nextDrawer = insertViewportIntoDrawer(detached[drawerKey], viewportId, activate);

    useLayoutStore.setState({
      ...detached,
      [drawerKey]: nextDrawer,
      activeViewportId: activate ? viewportId : state.activeViewportId,
      maximizedViewportId:
        state.maximizedViewportId === viewportId ? null : state.maximizedViewportId,
    });
  }

  toggleDrawer(side: DrawerSide): void {
    const state = useLayoutStore.getState();
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const drawer = state[drawerKey];
    if (drawer.viewportIds.length === 0) {
      useLayoutStore.setState({
        [drawerKey]: { ...drawer, open: false, activeViewportId: null },
      });
      return;
    }
    const nextOpen = !drawer.open;
    useLayoutStore.setState({
      [drawerKey]: {
        ...drawer,
        open: nextOpen,
        activeViewportId: drawer.activeViewportId ?? drawer.viewportIds[0] ?? null,
      },
    });
  }

  setDrawerOpen(side: DrawerSide, open: boolean): void {
    const state = useLayoutStore.getState();
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const drawer = state[drawerKey];
    useLayoutStore.setState({
      [drawerKey]: {
        ...drawer,
        open: drawer.viewportIds.length > 0 ? open : false,
        activeViewportId: drawer.activeViewportId ?? drawer.viewportIds[0] ?? null,
      },
    });
  }

  selectDrawerViewport(side: DrawerSide, viewportId: string): void {
    const state = useLayoutStore.getState();
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const drawer = state[drawerKey];
    if (!drawer.viewportIds.includes(viewportId)) return;

    if (drawer.open && drawer.activeViewportId === viewportId) {
      useLayoutStore.setState({
        [drawerKey]: { ...drawer, open: false },
      });
      return;
    }

    useLayoutStore.setState({
      [drawerKey]: { ...drawer, open: true, activeViewportId: viewportId },
      activeViewportId: viewportId,
    });
  }

  setDrawerWidth(side: DrawerSide, width: number): void {
    const clamped = Math.max(MIN_DRAWER_W, Math.min(MAX_DRAWER_W, Math.round(width)));
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    useLayoutStore.setState((state) => ({
      [drawerKey]: { ...state[drawerKey], width: clamped },
    }));
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
    const detached = detachViewportEverywhere(state, viewportId);
    const nextRoot = dockViewportAtEdge(detached.dockRoot, viewportId, edge, ratio);
    useLayoutStore.setState({
      ...detached,
      dockRoot: nextRoot,
      activeViewportId: viewportId,
      maximizedViewportId: null,
    });
  }

  dockToGroup(viewportId: string, targetGroupId: string, zone: DockZone, ratio = 0.5): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const detached = detachViewportEverywhere(state, viewportId);
    const nextRoot = dockViewportInGroup(detached.dockRoot, viewportId, targetGroupId, zone, ratio);
    useLayoutStore.setState({
      ...detached,
      dockRoot: nextRoot,
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

    const detached = detachViewportEverywhere(state, viewportId);
    const clamped = clampFloatRect(
      {
        width: rect?.width ?? desc?.defaultFloatSize?.width ?? 520,
        height: rect?.height ?? desc?.defaultFloatSize?.height ?? 360,
        x: rect?.x,
        y: rect?.y,
      },
      state.workspaceBounds,
      detached.floating.length,
    );

    useLayoutStore.setState({
      ...detached,
      floating: [...detached.floating, { viewportId, ...clamped, zIndex: nextZ }],
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
    source: 'docked' | 'floating' | 'drawer',
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

    if (drag.snapTarget?.kind === 'drawer') {
      this.dockToDrawer(drag.viewportId, drag.snapTarget.side, true);
      return;
    }

    if (drag.snapTarget?.kind === 'edge') {
      this.dockToEdge(drag.viewportId, drag.snapTarget.edge);
      return;
    }

    if (drag.snapTarget?.kind === 'group') {
      this.dockToGroup(drag.viewportId, drag.snapTarget.groupId, drag.snapTarget.zone);
      return;
    }

    if (drag.source === 'docked' || drag.source === 'drawer') {
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
    let nextLeft = createInitialLeftDrawer();
    let nextRight = createInitialRightDrawer();

    const terminals = allViewports.filter((v) => v.typeId === 'terminal.viewport');
    const leftDefaults = allViewports.filter(
      (v) =>
        v.typeId === 'hosts.manager' ||
        v.typeId === 'snippets.panel' ||
        v.typeId === 'history.panel',
    );
    const monitors = allViewports.filter((v) => v.typeId === 'monitor.panel');
    const others = allViewports.filter(
      (v) =>
        v.typeId !== 'terminal.viewport' &&
        v.typeId !== 'hosts.manager' &&
        v.typeId !== 'snippets.panel' &&
        v.typeId !== 'history.panel' &&
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

    for (const v of leftDefaults) {
      nextLeft = insertViewportIntoDrawer(nextLeft, v.id, v.typeId === 'hosts.manager');
    }
    if (nextLeft.viewportIds.length > 0 && !nextLeft.activeViewportId) {
      nextLeft.activeViewportId = nextLeft.viewportIds[0];
    }
    nextLeft.open = nextLeft.viewportIds.length > 0;

    for (const m of monitors) {
      nextRight = insertViewportIntoDrawer(nextRight, m.id, true);
    }
    nextRight.open = nextRight.viewportIds.length > 0;

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
      leftDrawer: nextLeft,
      rightDrawer: nextRight,
      dockRoot: nextRoot,
      floating: [],
      maximizedViewportId: null,
    });
  }

  resetForTesting(): void {
    useLayoutStore.setState({
      viewports: {},
      leftDrawer: createInitialLeftDrawer(),
      rightDrawer: createInitialRightDrawer(),
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
