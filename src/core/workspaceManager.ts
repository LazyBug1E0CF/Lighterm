import { harnessKernel } from '../harness/HarnessKernel';
import { collectGroups } from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';
import type {
  DockNode,
  FloatingViewportItem,
  ViewportInstance,
  WorkspaceState,
} from '../layout/types';
import type {
  SavedDockNode,
  SavedFloatingSlot,
  SavedTerminalSlot,
  SavedWorkspace,
} from '../types';
import { makeUuid } from './ipc';
import { shellService, useShellStore } from './shellService';
import { windowControls } from './windowControls';

const TERMINAL_VIEWPORT_TYPE = 'terminal.viewport';

function resolveWorkspaceSnapshot(
  workspace: WorkspaceState,
): WorkspaceState {
  const layoutState = useLayoutStore.getState();
  if (workspace.id !== layoutState.activeWorkspaceId) {
    return workspace;
  }
  return {
    ...workspace,
    dockRoot: layoutState.dockRoot,
    floating: layoutState.floating,
    activeViewportId: layoutState.activeViewportId,
    maximizedViewportId: layoutState.maximizedViewportId,
    layoutPreset: layoutState.activeLayoutPreset,
  };
}

function collectWorkspaceViewportOrder(ws: WorkspaceState): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const grp of collectGroups(ws.dockRoot)) {
    for (const vid of grp.viewportIds) {
      if (!seen.has(vid)) {
        seen.add(vid);
        ordered.push(vid);
      }
    }
  }
  for (const item of ws.floating) {
    if (!seen.has(item.viewportId)) {
      seen.add(item.viewportId);
      ordered.push(item.viewportId);
    }
  }
  return ordered;
}

function serializeDockTree(
  node: DockNode | null,
  slotByViewportId: Map<string, string>,
): SavedDockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    const slotIds = node.viewportIds
      .map((vid) => slotByViewportId.get(vid))
      .filter((sid): sid is string => Boolean(sid));
    if (slotIds.length === 0) return null;
    const mappedActive = node.activeViewportId
      ? slotByViewportId.get(node.activeViewportId)
      : undefined;
    return {
      type: 'group',
      slotIds,
      activeSlotId: mappedActive && slotIds.includes(mappedActive) ? mappedActive : slotIds[0],
    };
  }

  const first = serializeDockTree(node.first, slotByViewportId);
  const second = serializeDockTree(node.second, slotByViewportId);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first,
    second,
  };
}

function hydrateDockTree(
  node: SavedDockNode | null,
  viewportIdBySlot: Map<string, string>,
): DockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    const viewportIds = node.slotIds
      .map((sid) => viewportIdBySlot.get(sid))
      .filter((vid): vid is string => Boolean(vid));
    if (viewportIds.length === 0) return null;
    const mappedActive = node.activeSlotId ? viewportIdBySlot.get(node.activeSlotId) : undefined;
    return {
      type: 'group',
      id: makeUuid('grp'),
      viewportIds,
      activeViewportId:
        mappedActive && viewportIds.includes(mappedActive) ? mappedActive : viewportIds[0],
    };
  }

  const first = hydrateDockTree(node.first, viewportIdBySlot);
  const second = hydrateDockTree(node.second, viewportIdBySlot);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return {
    type: 'split',
    id: makeUuid('spl'),
    direction: node.direction,
    ratio: node.ratio,
    first,
    second,
  };
}

export function serializeWorkspaceSnapshot(
  workspace: WorkspaceState,
  viewports: Record<string, ViewportInstance>,
  overrideName?: string,
): SavedWorkspace {
  const ws = resolveWorkspaceSnapshot(workspace);
  const shellState = useShellStore.getState();
  const existingSaved = ws.savedWorkspaceId
    ? shellState.savedWorkspaces.find((item) => item.id === ws.savedWorkspaceId)
    : undefined;

  const orderedIds = collectWorkspaceViewportOrder(ws);
  const slotByViewportId = new Map<string, string>();
  const slots: SavedTerminalSlot[] = [];

  for (const vid of orderedIds) {
    const vp = viewports[vid];
    if (!vp || vp.typeId !== TERMINAL_VIEWPORT_TYPE) continue;

    const slotId = `slot-${slots.length + 1}`;
    slotByViewportId.set(vid, slotId);

    const sessionId = vp.params?.sessionId ? String(vp.params.sessionId) : '';
    const session = sessionId ? shellState.sessions[sessionId] : undefined;
    const hostId = session?.hostId ?? session?.info.hostId ?? undefined;

    slots.push({
      slotId,
      title: vp.title || session?.info.title || `Terminal ${slots.length + 1}`,
      kind: session?.info.kind ?? 'local',
      hostId: hostId ?? undefined,
      cwd: session?.cwd,
      shell: session?.shell,
    });
  }

  const dockRoot = serializeDockTree(ws.dockRoot, slotByViewportId);
  const floating: SavedFloatingSlot[] = ws.floating
    .filter((item) => slotByViewportId.has(item.viewportId))
    .map((item) => ({
      slotId: slotByViewportId.get(item.viewportId)!,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
      zIndex: item.zIndex,
    }));

  const activeSlotId = ws.activeViewportId
    ? (slotByViewportId.get(ws.activeViewportId) ?? null)
    : null;
  const maximizedSlotId = ws.maximizedViewportId
    ? (slotByViewportId.get(ws.maximizedViewportId) ?? null)
    : null;

  const now = Date.now();
  return {
    id: ws.savedWorkspaceId ?? makeUuid('saved-ws'),
    name: (overrideName ?? ws.name).trim() || ws.name,
    slots,
    dockRoot,
    floating,
    activeSlotId,
    maximizedSlotId,
    layoutPreset: ws.layoutPreset ?? null,
    createdAt: existingSaved?.createdAt ?? now,
    updatedAt: now,
  };
}

let unsubWorkspaceClose: (() => void) | null = null;
let unsubWindowClose: (() => void) | null = null;
let beforeUnloadHandler: (() => void) | null = null;
const openingSavedById = new Map<string, Promise<WorkspaceState | null>>();

export const workspaceManager = {
  installAutoSync(): void {
    if (!unsubWorkspaceClose) {
      unsubWorkspaceClose = layoutService.onBeforeWorkspaceClose((closingWs, viewports) => {
        if (!closingWs.savedWorkspaceId) return;
        const payload = serializeWorkspaceSnapshot(closingWs, viewports);
        void shellService.saveWorkspaceRecord(payload).catch(() => {});
      });
    }

    if (!unsubWindowClose) {
      unsubWindowClose = windowControls.registerBeforeWindowClose(() =>
        this.flushOpenSavedWorkspaces(),
      );
    }

    if (typeof window !== 'undefined' && !beforeUnloadHandler) {
      beforeUnloadHandler = () => {
        void this.flushOpenSavedWorkspaces().catch(() => {});
      };
      window.addEventListener('beforeunload', beforeUnloadHandler);
    }
  },

  async saveWorkspace(workspaceId?: string, overrideName?: string): Promise<SavedWorkspace> {
    const layoutState = useLayoutStore.getState();
    const targetId = workspaceId ?? layoutState.activeWorkspaceId;
    const ws = layoutState.workspaces.find((item) => item.id === targetId);
    if (!ws) {
      throw new Error('Workspace not found');
    }

    const payload = serializeWorkspaceSnapshot(ws, layoutState.viewports, overrideName);
    const saved = await shellService.saveWorkspaceRecord(payload);

    layoutService.setWorkspaceSavedId(ws.id, saved.id);
    if (saved.name !== ws.name) {
      layoutService.renameWorkspace(ws.id, saved.name);
    }
    return saved;
  },

  async renameLiveWorkspace(workspaceId: string, name: string): Promise<void> {
    const clean = name.trim();
    if (!clean) return;

    layoutService.renameWorkspace(workspaceId, clean);
    const layoutState = useLayoutStore.getState();
    const ws = layoutState.workspaces.find((item) => item.id === workspaceId);
    if (!ws?.savedWorkspaceId) return;

    const payload = serializeWorkspaceSnapshot(ws, layoutState.viewports, clean);
    await shellService.saveWorkspaceRecord(payload);
  },

  async renameSavedWorkspace(savedId: string, name: string): Promise<SavedWorkspace | null> {
    const clean = name.trim();
    if (!clean) return null;

    const shellState = useShellStore.getState();
    const existing = shellState.savedWorkspaces.find((item) => item.id === savedId);
    if (!existing) return null;

    const updated = await shellService.saveWorkspaceRecord({
      ...existing,
      name: clean,
    });

    for (const ws of useLayoutStore.getState().workspaces) {
      if (ws.savedWorkspaceId === savedId) {
        layoutService.renameWorkspace(ws.id, updated.name);
      }
    }

    return updated;
  },

  async deleteSavedWorkspace(savedId: string): Promise<void> {
    for (const ws of useLayoutStore.getState().workspaces) {
      if (ws.savedWorkspaceId === savedId) {
        layoutService.setWorkspaceSavedId(ws.id, null);
      }
    }
    await shellService.deleteSavedWorkspace(savedId);
  },

  async flushOpenSavedWorkspaces(): Promise<void> {
    const layoutState = useLayoutStore.getState();
    const savedIds = new Set(useShellStore.getState().savedWorkspaces.map((w) => w.id));
    for (const ws of layoutState.workspaces) {
      if (!ws.savedWorkspaceId || !savedIds.has(ws.savedWorkspaceId)) continue;
      const payload = serializeWorkspaceSnapshot(ws, layoutState.viewports);
      await shellService.saveWorkspaceRecord(payload);
    }
  },

  async openSavedWorkspace(savedId: string): Promise<WorkspaceState | null> {
    const existingLive = useLayoutStore
      .getState()
      .workspaces.find((ws) => ws.savedWorkspaceId === savedId);
    if (existingLive) {
      layoutService.selectWorkspace(existingLive.id);
      return existingLive;
    }

    const inflight = openingSavedById.get(savedId);
    if (inflight) return inflight;

    const task = (async (): Promise<WorkspaceState | null> => {
      let saved = useShellStore.getState().savedWorkspaces.find((item) => item.id === savedId);
      if (!saved) {
        const refreshed = await shellService.listSavedWorkspaces();
        saved = refreshed.find((item) => item.id === savedId);
      }
      if (!saved) return null;

      const hosts = useShellStore.getState().hosts;
      const terminalPluginId =
        harnessKernel.getViewportDescriptor(TERMINAL_VIEWPORT_TYPE)?.pluginId ?? 'lighterm.terminal';

      const createdEntries = await Promise.all(
        saved.slots.map(async (slot) => {
          const hasHost = Boolean(slot.hostId && hosts.some((h) => h.id === slot.hostId));
          const info =
            slot.kind === 'ssh' && hasHost && slot.hostId
              ? (await shellService.createSshSession({
                  hostId: slot.hostId,
                  meta: { skipAutoViewport: true },
                })) ??
                (await shellService.createLocalSession({
                  title: slot.title,
                  cwd: slot.cwd,
                  shell: slot.shell,
                  meta: { skipAutoViewport: true },
                }))
              : await shellService.createLocalSession({
                  title: slot.title,
                  cwd: slot.cwd,
                  shell: slot.shell,
                  meta: { skipAutoViewport: true },
                });
          return { slot, info };
        }),
      );

      const slotToViewportId = new Map<string, string>();
      const viewports: ViewportInstance[] = [];

      for (const { slot, info } of createdEntries) {
        if (!info) continue;
        const viewportId = makeUuid('vp');
        slotToViewportId.set(slot.slotId, viewportId);
        viewports.push({
          id: viewportId,
          typeId: TERMINAL_VIEWPORT_TYPE,
          pluginId: terminalPluginId,
          title: slot.title || info.title,
          params: { sessionId: info.id },
        });
      }

      const floating: FloatingViewportItem[] = saved.floating
        .map((item) => {
          const viewportId = slotToViewportId.get(item.slotId);
          if (!viewportId) return null;
          return {
            viewportId,
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            zIndex: item.zIndex,
          };
        })
        .filter((item): item is FloatingViewportItem => item !== null);

      let dockRoot = hydrateDockTree(saved.dockRoot, slotToViewportId);

      // Ensure any created viewports not placed in dockRoot or floating still get a docked tab
      const placedIds = new Set<string>([
        ...collectGroups(dockRoot).flatMap((g) => g.viewportIds),
        ...floating.map((f) => f.viewportId),
      ]);
      const orphanIds = viewports.map((v) => v.id).filter((id) => !placedIds.has(id));
      if (!dockRoot && orphanIds.length > 0) {
        dockRoot = {
          type: 'group',
          id: makeUuid('grp'),
          viewportIds: orphanIds,
          activeViewportId: orphanIds[0],
        };
      }

      const activeFromSlot = saved.activeSlotId
        ? (slotToViewportId.get(saved.activeSlotId) ?? null)
        : null;
      const activeViewportId = activeFromSlot ?? viewports[0]?.id ?? null;

      const maximizedViewportId = saved.maximizedSlotId
        ? (slotToViewportId.get(saved.maximizedSlotId) ?? null)
        : null;

      const currentWorkspaces = useLayoutStore.getState().workspaces;
      const sole = currentWorkspaces.length === 1 ? currentWorkspaces[0] : null;
      const targetWorkspaceId =
        sole &&
        !sole.savedWorkspaceId &&
        !sole.dockRoot &&
        sole.floating.length === 0 &&
        sole.name === 'Workspace 1'
          ? sole.id
          : makeUuid('ws');

      return layoutService.hydrateWorkspaceLayout(
        targetWorkspaceId,
        {
          name: saved.name,
          savedWorkspaceId: saved.id,
          viewports,
          dockRoot,
          floating,
          activeViewportId,
          maximizedViewportId,
          layoutPreset: saved.layoutPreset ?? null,
        },
        true,
      );
    })();

    openingSavedById.set(savedId, task);
    try {
      return await task;
    } finally {
      openingSavedById.delete(savedId);
    }
  },

  resetForTesting(): void {
    unsubWorkspaceClose?.();
    unsubWorkspaceClose = null;
    unsubWindowClose?.();
    unsubWindowClose = null;
    if (typeof window !== 'undefined' && beforeUnloadHandler) {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      beforeUnloadHandler = null;
    }
    openingSavedById.clear();
  },
};
