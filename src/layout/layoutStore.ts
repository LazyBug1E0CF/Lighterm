import { create } from 'zustand';
import { makeUuid } from '../core/ipc';
import type { ShellService } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import {
  buildPresetDockTree,
  collectGroups,
  dockViewportAtEdge,
  dockViewportInGroup,
  findGroupContainingViewport,
  removeViewportFromTree,
  setActiveViewportInGroup,
  setActiveViewportInTree,
  updateDockSplitRatio,
} from './dockTree';
import {
  captureLayoutSnapshot,
  resetLayoutAnimatorForTesting,
} from './layoutAnimator';
import type {
  DockEdge,
  DockNode,
  DockZone,
  DrawerSide,
  DrawerState,
  FloatingRect,
  FloatingViewportItem,
  OpenViewportOptions,
  QuickShellLayoutPreset,
  SnapTarget,
  ViewportDragState,
  ViewportInstance,
  WorkspaceState,
} from './types';

export interface LayoutStoreState {
  viewports: Record<string, ViewportInstance>;
  leftDrawer: DrawerState;
  rightDrawer: DrawerState;
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  dockRoot: DockNode | null;
  floating: FloatingViewportItem[];
  activeViewportId: string | null;
  maximizedViewportId: string | null;
  activeLayoutPreset: QuickShellLayoutPreset | null;
  layoutTransitionSeq: number;
  dragState: ViewportDragState | null;
  topZIndex: number;
  workspaceBounds: { width: number; height: number };
}

const MIN_FLOAT_W = 280;
const MIN_FLOAT_H = 180;
const MIN_DRAWER_W = 200;
const MAX_DRAWER_W = 600;
const TERMINAL_VIEWPORT_TYPE = 'terminal.viewport';

let workspaceSeq = 1;

function createInitialLeftDrawer(): DrawerState {
  return { open: true, width: 272, viewportIds: [], activeViewportId: null };
}

function createInitialRightDrawer(): DrawerState {
  return { open: true, width: 288, viewportIds: [], activeViewportId: null };
}

function createEmptyWorkspace(name = 'Workspace 1', id = 'ws-1'): WorkspaceState {
  return {
    id,
    name,
    dockRoot: null,
    floating: [],
    activeViewportId: null,
    maximizedViewportId: null,
    layoutPreset: 'tab',
  };
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

function detachViewportFromWorkspace(ws: WorkspaceState, viewportId: string): WorkspaceState {
  const nextRoot = removeViewportFromTree(ws.dockRoot, viewportId);
  const nextFloating = ws.floating.filter((f) => f.viewportId !== viewportId);
  const nextMax = ws.maximizedViewportId === viewportId ? null : ws.maximizedViewportId;
  const nextActive =
    ws.activeViewportId === viewportId
      ? collectGroups(nextRoot)[0]?.activeViewportId ??
        nextFloating[nextFloating.length - 1]?.viewportId ??
        null
      : ws.activeViewportId;

  if (
    nextRoot === ws.dockRoot &&
    nextFloating.length === ws.floating.length &&
    nextMax === ws.maximizedViewportId &&
    nextActive === ws.activeViewportId
  ) {
    return ws;
  }

  return {
    ...ws,
    dockRoot: nextRoot,
    floating: nextFloating,
    activeViewportId: nextActive,
    maximizedViewportId: nextMax,
  };
}

function detachViewportEverywhere(
  state: LayoutStoreState,
  viewportId: string,
): Pick<
  LayoutStoreState,
  'dockRoot' | 'floating' | 'leftDrawer' | 'rightDrawer' | 'workspaces'
> {
  return {
    dockRoot: removeViewportFromTree(state.dockRoot, viewportId),
    floating: state.floating.filter((f) => f.viewportId !== viewportId),
    leftDrawer: removeViewportFromDrawer(state.leftDrawer, viewportId),
    rightDrawer: removeViewportFromDrawer(state.rightDrawer, viewportId),
    workspaces: state.workspaces.map((ws) => detachViewportFromWorkspace(ws, viewportId)),
  };
}

function mirrorActiveWorkspace(
  state: LayoutStoreState,
  patch: Partial<LayoutStoreState>,
): Partial<LayoutStoreState> {
  const baseWorkspaces = patch.workspaces ?? state.workspaces;
  const targetWsId = patch.activeWorkspaceId ?? state.activeWorkspaceId;

  const nextDockRoot = 'dockRoot' in patch ? (patch.dockRoot ?? null) : state.dockRoot;
  const nextFloating = patch.floating ?? state.floating;
  const nextActiveViewportId =
    'activeViewportId' in patch ? (patch.activeViewportId ?? null) : state.activeViewportId;
  const nextMaxViewportId =
    'maximizedViewportId' in patch
      ? (patch.maximizedViewportId ?? null)
      : state.maximizedViewportId;
  const nextPreset =
    'activeLayoutPreset' in patch
      ? (patch.activeLayoutPreset ?? null)
      : state.activeLayoutPreset;

  const workspaces = baseWorkspaces.map((ws) =>
    ws.id === targetWsId
      ? {
          ...ws,
          dockRoot: nextDockRoot,
          floating: nextFloating,
          activeViewportId: nextActiveViewportId,
          maximizedViewportId: nextMaxViewportId,
          layoutPreset: nextPreset,
        }
      : ws,
  );

  return {
    ...patch,
    dockRoot: nextDockRoot,
    floating: nextFloating,
    activeViewportId: nextActiveViewportId,
    maximizedViewportId: nextMaxViewportId,
    activeLayoutPreset: nextPreset,
    workspaces,
  };
}

function collectOrderedWorkspaceIds(
  dockRoot: DockNode | null,
  floating: FloatingViewportItem[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const grp of collectGroups(dockRoot)) {
    for (const vid of grp.viewportIds) {
      if (!seen.has(vid)) {
        seen.add(vid);
        ordered.push(vid);
      }
    }
  }
  for (const item of floating) {
    if (!seen.has(item.viewportId)) {
      seen.add(item.viewportId);
      ordered.push(item.viewportId);
    }
  }
  return ordered;
}

function syncActiveSessionForWorkspace(
  dockRoot: DockNode | null,
  floating: FloatingViewportItem[],
  activeViewportId: string | null,
  viewports: Record<string, ViewportInstance>,
): void {
  const shell = harnessKernel.getService<ShellService>('core:shell');
  if (!shell) return;
  const wsIds = collectOrderedWorkspaceIds(dockRoot, floating);
  if (activeViewportId && wsIds.includes(activeViewportId)) {
    const activeVp = viewports[activeViewportId];
    if (activeVp?.typeId === TERMINAL_VIEWPORT_TYPE && activeVp.params?.sessionId) {
      shell.setActiveSession(String(activeVp.params.sessionId));
      return;
    }
  }
  const firstTerm = wsIds
    .map((id) => viewports[id])
    .find((vp) => vp?.typeId === TERMINAL_VIEWPORT_TYPE && vp.params?.sessionId);
  shell.setActiveSession(firstTerm ? String(firstTerm.params?.sessionId) : null);
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

const initialWorkspace = createEmptyWorkspace('Workspace 1', 'ws-1');

export const useLayoutStore = create<LayoutStoreState>(() => ({
  viewports: {},
  leftDrawer: createInitialLeftDrawer(),
  rightDrawer: createInitialRightDrawer(),
  workspaces: [initialWorkspace],
  activeWorkspaceId: initialWorkspace.id,
  dockRoot: null,
  floating: [],
  activeViewportId: null,
  maximizedViewportId: null,
  activeLayoutPreset: initialWorkspace.layoutPreset,
  layoutTransitionSeq: 0,
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

  getWorkspaceViewportIds(workspaceId?: string): string[] {
    const state = useLayoutStore.getState();
    const targetId = workspaceId ?? state.activeWorkspaceId;
    if (targetId === state.activeWorkspaceId) {
      return collectOrderedWorkspaceIds(state.dockRoot, state.floating);
    }
    const ws = state.workspaces.find((w) => w.id === targetId);
    if (!ws) return [];
    return collectOrderedWorkspaceIds(ws.dockRoot, ws.floating);
  }

  findWorkspaceViewportsByType(typeId: string, workspaceId?: string): ViewportInstance[] {
    const state = useLayoutStore.getState();
    return this.getWorkspaceViewportIds(workspaceId)
      .map((id) => state.viewports[id])
      .filter((vp): vp is ViewportInstance => Boolean(vp && vp.typeId === typeId));
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

  createWorkspace(name?: string): WorkspaceState {
    workspaceSeq += 1;
    const cleanName = name?.trim() || `Workspace ${workspaceSeq}`;
    const ws = createEmptyWorkspace(cleanName, makeUuid('ws'));
    const snap = captureLayoutSnapshot('workspace', 1);

    useLayoutStore.setState((state) => ({
      workspaces: [...state.workspaces, ws],
      activeWorkspaceId: ws.id,
      dockRoot: null,
      floating: [],
      activeViewportId: null,
      maximizedViewportId: null,
      activeLayoutPreset: ws.layoutPreset,
      layoutTransitionSeq: snap.seq,
      dragState: null,
    }));

    harnessKernel.getService<ShellService>('core:shell')?.setActiveSession(null);
    return ws;
  }

  selectWorkspace(workspaceId: string): void {
    const state = useLayoutStore.getState();
    if (state.activeWorkspaceId === workspaceId) return;
    const prevIdx = state.workspaces.findIndex((w) => w.id === state.activeWorkspaceId);
    const nextIdx = state.workspaces.findIndex((w) => w.id === workspaceId);
    if (nextIdx < 0) return;
    const target = state.workspaces[nextIdx];
    const snap = captureLayoutSnapshot('workspace', nextIdx >= prevIdx ? 1 : -1);

    useLayoutStore.setState({
      activeWorkspaceId: target.id,
      dockRoot: target.dockRoot,
      floating: target.floating,
      activeViewportId: target.activeViewportId,
      maximizedViewportId: target.maximizedViewportId,
      activeLayoutPreset: target.layoutPreset,
      layoutTransitionSeq: snap.seq,
      dragState: null,
    });

    syncActiveSessionForWorkspace(
      target.dockRoot,
      target.floating,
      target.activeViewportId,
      state.viewports,
    );
  }

  renameWorkspace(workspaceId: string, name: string): void {
    const clean = name.trim();
    if (!clean) return;
    useLayoutStore.setState((state) => ({
      workspaces: state.workspaces.map((ws) =>
        ws.id === workspaceId ? { ...ws, name: clean } : ws,
      ),
    }));
  }

  closeWorkspace(workspaceId: string): void {
    const state = useLayoutStore.getState();
    const targetIdx = state.workspaces.findIndex((w) => w.id === workspaceId);
    if (targetIdx < 0) return;
    const target = state.workspaces[targetIdx];

    const snap =
      state.workspaces.length <= 1 || state.activeWorkspaceId === workspaceId
        ? captureLayoutSnapshot('workspace', -1)
        : null;

    const targetViewportIds = collectOrderedWorkspaceIds(target.dockRoot, target.floating);
    const restViewports = { ...state.viewports };

    for (const vid of targetViewportIds) {
      const vp = state.viewports[vid];
      if (vp) {
        const desc = harnessKernel.getViewportDescriptor(vp.typeId);
        if (desc?.onClose) {
          try {
            desc.onClose(vp);
          } catch {
            // Ignore plugin close handler errors
          }
        }
        delete restViewports[vid];
      }
    }

    if (state.workspaces.length <= 1) {
      const resetWs: WorkspaceState = {
        ...target,
        dockRoot: null,
        floating: [],
        activeViewportId: null,
        maximizedViewportId: null,
        layoutPreset: 'tab',
      };
      useLayoutStore.setState({
        viewports: restViewports,
        workspaces: [resetWs],
        activeWorkspaceId: resetWs.id,
        dockRoot: null,
        floating: [],
        activeViewportId: null,
        maximizedViewportId: null,
        activeLayoutPreset: 'tab',
        layoutTransitionSeq: snap?.seq ?? state.layoutTransitionSeq,
        dragState: null,
      });
      harnessKernel.getService<ShellService>('core:shell')?.setActiveSession(null);
      return;
    }

    const remaining = state.workspaces.filter((w) => w.id !== workspaceId);
    if (state.activeWorkspaceId === workspaceId) {
      const nextWs = remaining[Math.min(targetIdx, remaining.length - 1)];
      useLayoutStore.setState({
        viewports: restViewports,
        workspaces: remaining,
        activeWorkspaceId: nextWs.id,
        dockRoot: nextWs.dockRoot,
        floating: nextWs.floating,
        activeViewportId: nextWs.activeViewportId,
        maximizedViewportId: nextWs.maximizedViewportId,
        activeLayoutPreset: nextWs.layoutPreset,
        layoutTransitionSeq: snap?.seq ?? state.layoutTransitionSeq,
        dragState: null,
      });
      syncActiveSessionForWorkspace(
        nextWs.dockRoot,
        nextWs.floating,
        nextWs.activeViewportId,
        restViewports,
      );
      return;
    }

    useLayoutStore.setState({
      viewports: restViewports,
      workspaces: remaining,
    });
  }

  arrangeWorkspaceShells(preset: QuickShellLayoutPreset, workspaceId?: string): void {
    const state = useLayoutStore.getState();
    const targetWsId = workspaceId ?? state.activeWorkspaceId;
    const isTargetActive = targetWsId === state.activeWorkspaceId;
    const targetWs = state.workspaces.find((w) => w.id === targetWsId);
    if (!targetWs) return;

    const currentDockRoot = isTargetActive ? state.dockRoot : targetWs.dockRoot;
    const currentFloating = isTargetActive ? state.floating : targetWs.floating;
    const currentActiveId = isTargetActive ? state.activeViewportId : targetWs.activeViewportId;

    const dockedIds = collectGroups(currentDockRoot).flatMap((g) => g.viewportIds);
    const floatingIds = currentFloating.map((f) => f.viewportId);
    const orderedIds = Array.from(new Set([...dockedIds, ...floatingIds]));

    const shellIds = orderedIds.filter(
      (id) => state.viewports[id]?.typeId === TERMINAL_VIEWPORT_TYPE,
    );
    const nonTerminalDockedIds = dockedIds.filter(
      (id) => state.viewports[id]?.typeId !== TERMINAL_VIEWPORT_TYPE && state.viewports[id],
    );
    const nonTerminalFloating = currentFloating.filter(
      (f) => state.viewports[f.viewportId]?.typeId !== TERMINAL_VIEWPORT_TYPE,
    );

    let nextRoot = buildPresetDockTree(shellIds, preset, currentActiveId);

    for (const id of nonTerminalDockedIds) {
      const vp = state.viewports[id];
      const desc = vp ? harnessKernel.getViewportDescriptor(vp.typeId) : undefined;
      const edge: DockEdge =
        desc?.defaultDock === 'left' ||
        desc?.defaultDock === 'right' ||
        desc?.defaultDock === 'top' ||
        desc?.defaultDock === 'bottom'
          ? desc.defaultDock
          : 'bottom';
      nextRoot = dockViewportAtEdge(nextRoot, id, edge);
    }

    const nextActive =
      currentActiveId && shellIds.includes(currentActiveId)
        ? currentActiveId
        : shellIds[0] ?? nonTerminalDockedIds[0] ?? nonTerminalFloating[0]?.viewportId ?? null;

    if (isTargetActive) {
      const snap = captureLayoutSnapshot('layout');
      useLayoutStore.setState((s) =>
        mirrorActiveWorkspace(s, {
          dockRoot: nextRoot,
          floating: nonTerminalFloating,
          activeViewportId: nextActive,
          maximizedViewportId: null,
          activeLayoutPreset: preset,
          layoutTransitionSeq: snap.seq,
        }),
      );
      syncActiveSessionForWorkspace(nextRoot, nonTerminalFloating, nextActive, state.viewports);
      return;
    }

    useLayoutStore.setState((s) => ({
      workspaces: s.workspaces.map((ws) =>
        ws.id === targetWsId
          ? {
              ...ws,
              dockRoot: nextRoot,
              floating: nonTerminalFloating,
              activeViewportId: nextActive,
              maximizedViewportId: null,
              layoutPreset: preset,
            }
          : ws,
      ),
    }));
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
    const snap = captureLayoutSnapshot('layout');

    if (opts.preferredDock === 'left-drawer' || opts.preferredDock === 'right-drawer') {
      const activate = opts.activateDrawer ?? true;
      const side: DrawerSide = opts.preferredDock === 'left-drawer' ? 'left' : 'right';
      const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
      const nextDrawer = insertViewportIntoDrawer(state[drawerKey], id, activate);
      useLayoutStore.setState((s) =>
        mirrorActiveWorkspace(s, {
          viewports: nextViewports,
          [drawerKey]: nextDrawer,
          activeViewportId: activate ? id : s.activeViewportId,
          layoutTransitionSeq: snap.seq,
        }),
      );
      return instance;
    }

    if (opts.preferredDock === 'float') {
      const nextZ = state.topZIndex + 1;
      const rect = clampFloatRect(opts.floatRect ?? {}, state.workspaceBounds, state.floating.length);
      useLayoutStore.setState((s) =>
        mirrorActiveWorkspace(s, {
          viewports: nextViewports,
          floating: [...s.floating, { viewportId: id, ...rect, zIndex: nextZ }],
          activeViewportId: id,
          topZIndex: nextZ,
          layoutTransitionSeq: snap.seq,
        }),
      );
      return instance;
    }

    let nextRoot: DockNode | null = state.dockRoot;
    const isExplicitSplit = Boolean(opts.targetGroupId && opts.splitZone && opts.splitZone !== 'center');
    const isAutoPresetTerminal =
      opts.typeId === TERMINAL_VIEWPORT_TYPE &&
      !isExplicitSplit &&
      (opts.preferredDock === 'center' || !opts.preferredDock) &&
      Boolean(state.activeLayoutPreset && state.activeLayoutPreset !== 'tab');

    if (opts.targetGroupId) {
      nextRoot = dockViewportInGroup(
        state.dockRoot,
        id,
        opts.targetGroupId,
        opts.splitZone ?? 'center',
      );
    } else if (opts.preferredDock === 'center' || !opts.preferredDock) {
      const groups = collectGroups(state.dockRoot);
      const sameTypeGroups = groups.filter((g) =>
        g.viewportIds.some((vid) => nextViewports[vid]?.typeId === opts.typeId),
      );
      const targetSameTypeGroup = isAutoPresetTerminal
        ? sameTypeGroups[sameTypeGroups.length - 1]
        : sameTypeGroups.find(
            (g) => state.activeViewportId && g.viewportIds.includes(state.activeViewportId),
          ) ?? sameTypeGroups[0];
      if (targetSameTypeGroup) {
        nextRoot = dockViewportInGroup(state.dockRoot, id, targetSameTypeGroup.id, 'center');
      } else if (groups.length === 0) {
        nextRoot = dockViewportAtEdge(null, id, 'left');
      } else {
        const middleGroup = groups[Math.floor(groups.length / 2)];
        nextRoot = dockViewportInGroup(state.dockRoot, id, middleGroup.id, 'center');
      }
    } else {
      nextRoot = dockViewportAtEdge(state.dockRoot, id, opts.preferredDock);
    }

    const nextPreset =
      isExplicitSplit && opts.typeId === TERMINAL_VIEWPORT_TYPE
        ? null
        : state.activeLayoutPreset;

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        viewports: nextViewports,
        dockRoot: nextRoot,
        activeViewportId: id,
        activeLayoutPreset: nextPreset,
        layoutTransitionSeq: snap.seq,
      }),
    );

    if (isAutoPresetTerminal && state.activeLayoutPreset) {
      this.arrangeWorkspaceShells(state.activeLayoutPreset);
    }

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
      if (loc === null) {
        const preferred = opts.preferredDock ?? 'bottom';
        if (preferred === 'left-drawer' || preferred === 'right-drawer') {
          this.dockToDrawer(existing.id, preferred === 'left-drawer' ? 'left' : 'right', true);
        } else if (preferred === 'float') {
          this.floatViewport(existing.id, opts.floatRect);
        } else {
          const edge: DockEdge = preferred === 'center' ? 'bottom' : preferred;
          this.dockToEdge(existing.id, edge);
        }
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

    const snap = captureLayoutSnapshot('layout');
    const wasTerminal = existing.typeId === TERMINAL_VIEWPORT_TYPE;
    const wasInActiveWorkspaceDock =
      Boolean(findGroupContainingViewport(state.dockRoot, viewportId)) ||
      state.floating.some((f) => f.viewportId === viewportId);
    const presetToReapply =
      wasTerminal &&
      wasInActiveWorkspaceDock &&
      state.activeLayoutPreset &&
      state.activeLayoutPreset !== 'tab'
        ? state.activeLayoutPreset
        : null;

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

    const nextMax = state.maximizedViewportId === viewportId ? null : state.maximizedViewportId;

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        viewports: restViewports,
        ...detached,
        activeViewportId: nextActive,
        maximizedViewportId: nextMax,
        layoutTransitionSeq: snap.seq,
      }),
    );

    if (presetToReapply) {
      this.arrangeWorkspaceShells(presetToReapply);
    } else if (wasInActiveWorkspaceDock) {
      syncActiveSessionForWorkspace(detached.dockRoot, detached.floating, nextActive, restViewports);
    }
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

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        activeViewportId: viewportId,
        dockRoot: setActiveViewportInTree(s.dockRoot, viewportId),
        floating: nextFloating,
        leftDrawer: inLeft
          ? { ...s.leftDrawer, open: true, activeViewportId: viewportId }
          : s.leftDrawer,
        rightDrawer: inRight
          ? { ...s.rightDrawer, open: true, activeViewportId: viewportId }
          : s.rightDrawer,
        topZIndex: nextZ,
      }),
    );
  }

  dockToDrawer(viewportId: string, side: DrawerSide, activate = true): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const snap = captureLayoutSnapshot('layout');
    const detached = detachViewportEverywhere(state, viewportId);
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const nextDrawer = insertViewportIntoDrawer(detached[drawerKey], viewportId, activate);

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        ...detached,
        [drawerKey]: nextDrawer,
        activeViewportId: activate ? viewportId : s.activeViewportId,
        maximizedViewportId: s.maximizedViewportId === viewportId ? null : s.maximizedViewportId,
        layoutTransitionSeq: snap.seq,
      }),
    );
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
    const snap = captureLayoutSnapshot('layout');
    const nextOpen = !drawer.open;
    useLayoutStore.setState({
      [drawerKey]: {
        ...drawer,
        open: nextOpen,
        activeViewportId: drawer.activeViewportId ?? drawer.viewportIds[0] ?? null,
      },
      layoutTransitionSeq: snap.seq,
    });
  }

  setDrawerOpen(side: DrawerSide, open: boolean): void {
    const state = useLayoutStore.getState();
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const drawer = state[drawerKey];
    const nextOpen = drawer.viewportIds.length > 0 ? open : false;
    const snap = nextOpen !== drawer.open ? captureLayoutSnapshot('layout') : null;
    useLayoutStore.setState({
      [drawerKey]: {
        ...drawer,
        open: nextOpen,
        activeViewportId: drawer.activeViewportId ?? drawer.viewportIds[0] ?? null,
      },
      ...(snap ? { layoutTransitionSeq: snap.seq } : {}),
    });
  }

  selectDrawerViewport(side: DrawerSide, viewportId: string): void {
    const state = useLayoutStore.getState();
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    const drawer = state[drawerKey];
    if (!drawer.viewportIds.includes(viewportId)) return;

    if (drawer.open && drawer.activeViewportId === viewportId) {
      const snap = captureLayoutSnapshot('layout');
      useLayoutStore.setState({
        [drawerKey]: { ...drawer, open: false },
        layoutTransitionSeq: snap.seq,
      });
      return;
    }

    const snap = !drawer.open ? captureLayoutSnapshot('layout') : null;
    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        [drawerKey]: { ...drawer, open: true, activeViewportId: viewportId },
        activeViewportId: viewportId,
        ...(snap ? { layoutTransitionSeq: snap.seq } : {}),
      }),
    );
  }

  setDrawerWidth(side: DrawerSide, width: number): void {
    const clamped = Math.max(MIN_DRAWER_W, Math.min(MAX_DRAWER_W, Math.round(width)));
    const drawerKey = side === 'left' ? 'leftDrawer' : 'rightDrawer';
    useLayoutStore.setState((state) => ({
      [drawerKey]: { ...state[drawerKey], width: clamped },
    }));
  }

  selectGroupTab(groupId: string, viewportId: string): void {
    useLayoutStore.setState((state) =>
      mirrorActiveWorkspace(state, {
        dockRoot: setActiveViewportInGroup(state.dockRoot, groupId, viewportId),
        activeViewportId: viewportId,
      }),
    );
  }

  dockToEdge(viewportId: string, edge: DockEdge, ratio?: number): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const snap = captureLayoutSnapshot('layout');
    const detached = detachViewportEverywhere(state, viewportId);
    const nextRoot = dockViewportAtEdge(detached.dockRoot, viewportId, edge, ratio);
    const nextPreset =
      state.viewports[viewportId].typeId === TERMINAL_VIEWPORT_TYPE
        ? null
        : state.activeLayoutPreset;
    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        ...detached,
        dockRoot: nextRoot,
        activeViewportId: viewportId,
        maximizedViewportId: null,
        activeLayoutPreset: nextPreset,
        layoutTransitionSeq: snap.seq,
      }),
    );
  }

  dockToGroup(viewportId: string, targetGroupId: string, zone: DockZone, ratio = 0.5): void {
    const state = useLayoutStore.getState();
    if (!state.viewports[viewportId]) return;
    const snap = captureLayoutSnapshot('layout');
    const detached = detachViewportEverywhere(state, viewportId);
    const nextRoot = dockViewportInGroup(detached.dockRoot, viewportId, targetGroupId, zone, ratio);
    const nextPreset =
      zone !== 'center' && state.viewports[viewportId].typeId === TERMINAL_VIEWPORT_TYPE
        ? null
        : state.activeLayoutPreset;
    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        ...detached,
        dockRoot: nextRoot,
        activeViewportId: viewportId,
        maximizedViewportId: null,
        activeLayoutPreset: nextPreset,
        layoutTransitionSeq: snap.seq,
      }),
    );
  }

  floatViewport(viewportId: string, rect?: Partial<FloatingRect>): void {
    const state = useLayoutStore.getState();
    const vp = state.viewports[viewportId];
    if (!vp) return;

    const desc = harnessKernel.getViewportDescriptor(vp.typeId);
    const existingFloat = state.floating.find((f) => f.viewportId === viewportId);
    const nextZ = state.topZIndex + 1;
    const nextPreset =
      vp.typeId === TERMINAL_VIEWPORT_TYPE ? null : state.activeLayoutPreset;

    if (existingFloat) {
      const clamped = clampFloatRect({ ...existingFloat, ...rect }, state.workspaceBounds);
      useLayoutStore.setState((s) =>
        mirrorActiveWorkspace(s, {
          floating: s.floating.map((f) =>
            f.viewportId === viewportId ? { viewportId, ...clamped, zIndex: nextZ } : f,
          ),
          activeViewportId: viewportId,
          topZIndex: nextZ,
          maximizedViewportId: null,
          activeLayoutPreset: nextPreset,
        }),
      );
      return;
    }

    const snap = captureLayoutSnapshot('layout');
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

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        ...detached,
        floating: [...detached.floating, { viewportId, ...clamped, zIndex: nextZ }],
        activeViewportId: viewportId,
        topZIndex: nextZ,
        maximizedViewportId: null,
        activeLayoutPreset: nextPreset,
        layoutTransitionSeq: snap.seq,
      }),
    );
  }

  moveFloating(viewportId: string, x: number, y: number): void {
    useLayoutStore.setState((state) => {
      const clampedX = Math.max(0, Math.min(Math.max(0, state.workspaceBounds.width - 120), x));
      const clampedY = Math.max(0, Math.min(Math.max(0, state.workspaceBounds.height - 60), y));
      return mirrorActiveWorkspace(state, {
        floating: state.floating.map((f) =>
          f.viewportId === viewportId ? { ...f, x: clampedX, y: clampedY } : f,
        ),
      });
    });
  }

  resizeFloating(viewportId: string, rect: FloatingRect): void {
    useLayoutStore.setState((state) => {
      const clamped = clampFloatRect(rect, state.workspaceBounds);
      return mirrorActiveWorkspace(state, {
        floating: state.floating.map((f) =>
          f.viewportId === viewportId ? { ...f, ...clamped } : f,
        ),
      });
    });
  }

  setSplitRatio(splitId: string, ratio: number): void {
    useLayoutStore.setState((state) =>
      mirrorActiveWorkspace(state, {
        dockRoot: updateDockSplitRatio(state.dockRoot, splitId, ratio),
      }),
    );
  }

  toggleMaximize(viewportId: string): void {
    const snap = captureLayoutSnapshot('layout');
    useLayoutStore.setState((state) =>
      mirrorActiveWorkspace(state, {
        maximizedViewportId: state.maximizedViewportId === viewportId ? null : viewportId,
        activeViewportId: viewportId,
        layoutTransitionSeq: snap.seq,
      }),
    );
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
    const snap = captureLayoutSnapshot('layout');
    const state = useLayoutStore.getState();
    const activeWsIds = new Set(this.getWorkspaceViewportIds(state.activeWorkspaceId));
    const scopedViewports = Object.values(state.viewports).filter(
      (v) =>
        activeWsIds.has(v.id) ||
        state.leftDrawer.viewportIds.includes(v.id) ||
        state.rightDrawer.viewportIds.includes(v.id),
    );

    let nextRoot: DockNode | null = null;
    let nextLeft = createInitialLeftDrawer();
    let nextRight = createInitialRightDrawer();

    const terminals = scopedViewports.filter((v) => v.typeId === TERMINAL_VIEWPORT_TYPE);
    const leftDefaults = scopedViewports.filter(
      (v) =>
        v.typeId === 'hosts.manager' ||
        v.typeId === 'snippets.panel' ||
        v.typeId === 'history.panel',
    );
    const monitors = scopedViewports.filter((v) => v.typeId === 'monitor.panel');
    const others = scopedViewports.filter(
      (v) =>
        v.typeId !== TERMINAL_VIEWPORT_TYPE &&
        v.typeId !== 'hosts.manager' &&
        v.typeId !== 'snippets.panel' &&
        v.typeId !== 'history.panel' &&
        v.typeId !== 'monitor.panel',
    );

    nextRoot = buildPresetDockTree(
      terminals.map((t) => t.id),
      'tab',
      state.activeViewportId,
    );

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

    useLayoutStore.setState((s) =>
      mirrorActiveWorkspace(s, {
        leftDrawer: nextLeft,
        rightDrawer: nextRight,
        dockRoot: nextRoot,
        floating: [],
        maximizedViewportId: null,
        activeLayoutPreset: 'tab',
        layoutTransitionSeq: snap.seq,
      }),
    );
  }

  resetForTesting(): void {
    workspaceSeq = 1;
    resetLayoutAnimatorForTesting();
    const resetWs = createEmptyWorkspace('Workspace 1', 'ws-1');
    useLayoutStore.setState({
      viewports: {},
      leftDrawer: createInitialLeftDrawer(),
      rightDrawer: createInitialRightDrawer(),
      workspaces: [resetWs],
      activeWorkspaceId: resetWs.id,
      dockRoot: null,
      floating: [],
      activeViewportId: null,
      maximizedViewportId: null,
      activeLayoutPreset: resetWs.layoutPreset,
      layoutTransitionSeq: 0,
      dragState: null,
      topZIndex: 20,
      workspaceBounds: { width: 1200, height: 760 },
    });
  }
}

export const layoutService = new LayoutService();
