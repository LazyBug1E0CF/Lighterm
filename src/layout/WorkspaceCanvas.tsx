import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Minimize2, Terminal } from 'lucide-react';
import { isWebRuntime } from '../core/ipc';
import { shellService, useShellStore } from '../core/shellService';
import { useWebAuthStore } from '../core/webTransport';
import { useViewportDescriptors } from '../kernel/KernelContext';
import { TERMINAL_VIEWPORT_TYPE } from '../plugins/terminal/terminalService';
import { DockGroupView } from './DockGroupView';
import {
  collectGroups,
  computeFlatDockLayout,
  type DockSplitSeparatorSlot,
  pruneUnavailableViewports,
} from './dockTree';
import { FloatingViewportWindow } from './FloatingViewportWindow';
import { getLatestLayoutSnapshot, playLayoutAnimation } from './layoutAnimator';
import { layoutService, useLayoutStore } from './layoutStore';
import { NewShellButton, QuickShellLayoutButtons } from './QuickShellLayoutBar';
import { SideDrawer } from './SideDrawer';
import type { DockEdge, DockZone, DrawerSide, SnapTarget } from './types';
import { WorkspaceEmptyView } from './WorkspaceEmptyView';

interface SplitSeparatorOverlayProps {
  sep: DockSplitSeparatorSlot;
  stageRef: React.RefObject<HTMLDivElement | null>;
  dockEdge?: 'bottom';
}

const SplitSeparatorOverlay: React.FC<SplitSeparatorOverlayProps> = ({
  sep,
  stageRef,
  dockEdge,
}) => {
  const [resizing, setResizing] = useState(false);
  const isDraggingAny = useLayoutStore((s) => Boolean(s.dragState?.active));
  const isHorizontal = sep.direction === 'horizontal';

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    setResizing(true);

    const onMove = (ev: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const branchSize = isHorizontal
        ? (rect.width * sep.branchWidth) / 100
        : (rect.height * sep.branchHeight) / 100;
      if (branchSize <= 0) return;
      const branchStart = isHorizontal
        ? rect.left + (rect.width * sep.branchLeft) / 100
        : rect.top + (rect.height * sep.branchTop) / 100;
      const pointerCoord = isHorizontal ? ev.clientX : ev.clientY;
      layoutService.setSplitRatio(sep.splitId, (pointerCoord - branchStart) / branchSize);
    };

    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      data-split-separator-edge={dockEdge}
      onPointerDown={startResize}
      style={
        isHorizontal
          ? { left: `${sep.left}%`, top: `${sep.top}%`, height: `${sep.length}%` }
          : { left: `${sep.left}%`, top: `${sep.top}%`, width: `${sep.length}%` }
      }
      className={`absolute z-10 bg-[var(--border-subtle)] ${
        isHorizontal
          ? "w-px -translate-x-1/2 cursor-col-resize before:content-[''] before:absolute before:inset-y-0 before:-left-[3px] before:-right-[3px] after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-0.5 after:transition-colors"
          : "h-px -translate-y-1/2 cursor-row-resize before:content-[''] before:absolute before:inset-x-0 before:-top-[3px] before:-bottom-[3px] after:content-[''] after:absolute after:inset-x-0 after:top-1/2 after:-translate-y-1/2 after:h-0.5 after:transition-colors"
      } ${resizing ? 'after:bg-[var(--accent)]' : 'after:bg-transparent hover:after:bg-[var(--accent)]'} ${
        isDraggingAny ? 'pointer-events-none' : ''
      }`}
    />
  );
};

function previewStyleForSnap(snap: SnapTarget | null): React.CSSProperties | null {
  if (!snap) return null;
  if (snap.kind === 'edge') {
    if (snap.edge === 'left') return { left: 0, top: 0, bottom: 0, width: '25%' };
    if (snap.edge === 'right') return { right: 0, top: 0, bottom: 0, width: '25%' };
    if (snap.edge === 'top') return { left: 0, right: 0, top: 0, height: '30%' };
    return { left: 0, right: 0, bottom: 0, height: '30%' };
  }
  return null;
}

const WorkspaceShellToolbar: React.FC = () => {
  const dockRoot = useLayoutStore((s) => s.dockRoot);
  const floating = useLayoutStore((s) => s.floating);
  const viewports = useLayoutStore((s) => s.viewports);
  const activeViewportId = useLayoutStore((s) => s.activeViewportId);
  const sessions = useShellStore((s) => s.sessions);
  const sessionStatuses = useShellStore((s) => s.sessionStatuses);

  const shellViewports = useMemo(() => {
    const ids = new Set<string>();
    for (const grp of collectGroups(dockRoot)) {
      for (const vid of grp.viewportIds) ids.add(vid);
    }
    for (const item of floating) {
      ids.add(item.viewportId);
    }
    return Array.from(ids)
      .map((id) => viewports[id])
      .filter((vp) => Boolean(vp && vp.typeId === TERMINAL_VIEWPORT_TYPE));
  }, [dockRoot, floating, viewports]);

  return (
    <div
      aria-label="Workspace Shell Toolbar"
      className="lighterm-toolbar-enter h-8 px-2 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0 select-none"
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      <div className="flex-1 flex items-center gap-1 overflow-x-auto lighterm-scroll min-w-0">
        {shellViewports.map((vp) => {
          const sid = String(vp.params?.sessionId ?? '');
          const status = sessionStatuses[sid] ?? sessions[sid]?.info.status ?? 'connected';
          const isFocused = activeViewportId === vp.id;
          const dotColor =
            status === 'connected'
              ? 'var(--success)'
              : status === 'connecting'
                ? 'var(--warning)'
                : status === 'error'
                  ? 'var(--danger)'
                  : 'var(--text-muted)';

          return (
            <button
              key={vp.id}
              type="button"
              data-flip-tab-id={vp.id}
              onClick={() => {
                layoutService.setActiveViewport(vp.id);
                if (sid) shellService.setActiveSession(sid);
              }}
              className={`h-6 px-2 rounded text-xs flex items-center gap-1.5 shrink-0 max-w-[160px] border transition-colors ${
                isFocused
                  ? 'bg-[var(--bg-elevated)] border-[var(--accent)]/40 text-[var(--text-primary)] font-medium'
                  : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]/60 hover:text-[var(--text-primary)]'
              }`}
            >
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: dotColor }}
              />
              <Terminal className="w-3 h-3 shrink-0 text-[var(--accent)]" />
              <span className="truncate">{vp.title}</span>
            </button>
          );
        })}

        <NewShellButton />
      </div>

      <QuickShellLayoutButtons />
    </div>
  );
};

export const WorkspaceCanvas: React.FC = () => {
  const dockRoot = useLayoutStore((s) => s.dockRoot);
  const floating = useLayoutStore((s) => s.floating);
  const viewports = useLayoutStore((s) => s.viewports);
  const maximizedViewportId = useLayoutStore((s) => s.maximizedViewportId);
  const dragState = useLayoutStore((s) => s.dragState);
  const layoutTransitionSeq = useLayoutStore((s) => s.layoutTransitionSeq);
  const descriptors = useViewportDescriptors();
  const webLocalShellEnabled = useWebAuthStore((s) => s.localShellEnabled);
  const localShellAllowed = !isWebRuntime() || webLocalShellEnabled;

  const canvasRootRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (layoutTransitionSeq <= 0) return;
    playLayoutAnimation(
      canvasRootRef.current,
      workspaceRef.current,
      getLatestLayoutSnapshot(),
      useLayoutStore.getState().activeViewportId,
    );
  }, [layoutTransitionSeq]);

  const visibleDockRoot = useMemo(
    () =>
      pruneUnavailableViewports(dockRoot, (vid) => {
        const vp = viewports[vid];
        return Boolean(vp && descriptors[vp.typeId]);
      }),
    [dockRoot, viewports, descriptors],
  );

  const visibleGroups = useMemo(() => collectGroups(visibleDockRoot), [visibleDockRoot]);
  const flatDockLayout = useMemo(() => computeFlatDockLayout(visibleDockRoot), [visibleDockRoot]);
  const bottomEdgeSlot = useMemo(
    () =>
      flatDockLayout.groups.length > 1
        ? flatDockLayout.groups.find(
            (slot) =>
              slot.top > 0.5 &&
              slot.top + slot.height >= 99.5 &&
              slot.left <= 0.5 &&
              slot.width >= 99.5,
          )
        : undefined,
    [flatDockLayout],
  );

  const visibleFloating = useMemo(
    () =>
      floating.filter((item) => {
        const vp = viewports[item.viewportId];
        return Boolean(vp && descriptors[vp.typeId]);
      }),
    [floating, viewports, descriptors],
  );

  useEffect(() => {
    const el = workspaceRef.current;
    if (!el) return;
    const syncSize = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        layoutService.setWorkspaceBounds(el.clientWidth, el.clientHeight);
      }
    };
    syncSize();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const isTrackingDrag = Boolean(dragState);
  useEffect(() => {
    if (!isTrackingDrag) {
      setHoveredGroupId(null);
      return;
    }

    const hitMatchesPoint = (el: HTMLElement, x: number, y: number): boolean => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    const resolveDropTarget = (
      x: number,
      y: number,
    ): { snap: SnapTarget | null; groupId: string | null } => {
      const elements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(x, y)
          : [];

      let snap: SnapTarget | null = null;
      let groupId: string | null = null;

      for (const el of elements) {
        if (!(el instanceof HTMLElement)) continue;
        if (!snap && el.dataset.dropDrawer) {
          snap = { kind: 'drawer', side: el.dataset.dropDrawer as DrawerSide };
        }
        if (!snap && el.dataset.dropEdge) {
          snap = { kind: 'edge', edge: el.dataset.dropEdge as DockEdge };
        }
        if (!snap && el.dataset.dropGroup && el.dataset.dropZone) {
          snap = {
            kind: 'group',
            groupId: el.dataset.dropGroup,
            zone: el.dataset.dropZone as DockZone,
          };
        }
        if (!groupId && el.dataset.groupContainer) {
          groupId = el.dataset.groupContainer;
        }
      }

      if (!snap && canvasRootRef.current) {
        const compassTargets =
          canvasRootRef.current.querySelectorAll<HTMLElement>('[data-drop-group][data-drop-zone]');
        for (const el of compassTargets) {
          if (hitMatchesPoint(el, x, y) && el.dataset.dropGroup && el.dataset.dropZone) {
            snap = {
              kind: 'group',
              groupId: el.dataset.dropGroup,
              zone: el.dataset.dropZone as DockZone,
            };
            break;
          }
        }
      }

      if (!snap && canvasRootRef.current) {
        const edgeTargets = canvasRootRef.current.querySelectorAll<HTMLElement>('[data-drop-edge]');
        for (const el of edgeTargets) {
          if (hitMatchesPoint(el, x, y) && el.dataset.dropEdge) {
            snap = { kind: 'edge', edge: el.dataset.dropEdge as DockEdge };
            break;
          }
        }
      }

      if (!snap && canvasRootRef.current) {
        const railTargets = canvasRootRef.current.querySelectorAll<HTMLElement>(
          '[data-activity-rail][data-drop-drawer]',
        );
        for (const el of railTargets) {
          if (hitMatchesPoint(el, x, y) && el.dataset.dropDrawer) {
            snap = { kind: 'drawer', side: el.dataset.dropDrawer as DrawerSide };
            break;
          }
        }
      }

      if (!snap && canvasRootRef.current) {
        const drawerTargets =
          canvasRootRef.current.querySelectorAll<HTMLElement>('[data-drop-drawer]');
        for (const el of drawerTargets) {
          if (hitMatchesPoint(el, x, y) && el.dataset.dropDrawer) {
            snap = { kind: 'drawer', side: el.dataset.dropDrawer as DrawerSide };
            break;
          }
        }
      }

      if (!groupId && workspaceRef.current) {
        const groups = workspaceRef.current.querySelectorAll<HTMLElement>('[data-group-container]');
        for (const grpEl of groups) {
          const r = grpEl.getBoundingClientRect();
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            groupId = grpEl.dataset.groupContainer ?? null;
            break;
          }
        }
      }

      return { snap, groupId };
    };

    const initialDrag = useLayoutStore.getState().dragState;
    if (initialDrag?.active) {
      const { snap, groupId } = resolveDropTarget(initialDrag.currentX, initialDrag.currentY);
      setHoveredGroupId(groupId);
      layoutService.updateDrag(initialDrag.currentX, initialDrag.currentY, snap);
    }

    const onMove = (ev: PointerEvent) => {
      const { snap, groupId } = resolveDropTarget(ev.clientX, ev.clientY);
      setHoveredGroupId(groupId);
      layoutService.updateDrag(ev.clientX, ev.clientY, snap);
    };

    const onUp = () => {
      setHoveredGroupId(null);
      layoutService.commitDrag();
    };

    const onCancel = () => {
      setHoveredGroupId(null);
      layoutService.cancelDrag();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setHoveredGroupId(null);
        layoutService.cancelDrag();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isTrackingDrag]);

  const maximizedVp = maximizedViewportId ? viewports[maximizedViewportId] : undefined;
  const maximizedDesc = maximizedVp ? descriptors[maximizedVp.typeId] : undefined;
  const MaxComponent = maximizedDesc?.component;

  const terminalGroups = visibleGroups.filter((grp) =>
    grp.viewportIds.some((vid) => viewports[vid]?.typeId === TERMINAL_VIEWPORT_TYPE),
  );
  const hasFloatingTerminal = visibleFloating.some(
    (item) => viewports[item.viewportId]?.typeId === TERMINAL_VIEWPORT_TYPE,
  );
  const inlineControlsGroupId =
    maximizedVp || hasFloatingTerminal
      ? null
      : terminalGroups.length === 1
        ? terminalGroups[0].id
        : terminalGroups.length === 0 && visibleGroups.length === 1
          ? visibleGroups[0].id
          : null;
  const showTopShellToolbar = !maximizedVp && inlineControlsGroupId === null;
  const isMultiGroup = visibleGroups.length > 1;

  const snapPreviewStyle = previewStyleForSnap(dragState?.active ? dragState.snapTarget : null);

  return (
    <div
      ref={canvasRootRef}
      className="relative flex-1 flex min-w-0 min-h-0 overflow-hidden"
    >
      <SideDrawer side="left" />

      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {showTopShellToolbar && <WorkspaceShellToolbar />}

        <div ref={workspaceRef} className="relative flex-1 flex min-w-0 min-h-0 overflow-hidden">
          {maximizedVp && MaxComponent ? (
            <div
              data-flip-id={maximizedVp.id}
              data-maximized-viewport="true"
              className="flex-1 flex flex-col min-w-0 min-h-0"
            >
              <div
                className="h-8 px-3 flex items-center justify-between border-b border-[var(--border-subtle)] text-xs shrink-0"
                style={{ backgroundColor: 'var(--bg-elevated)' }}
              >
                <span className="font-medium text-[var(--text-primary)]">{maximizedVp.title}</span>
                <button
                  type="button"
                  onClick={() => layoutService.toggleMaximize(maximizedVp.id)}
                  aria-label="Restore Maximized Viewport"
                  className="px-2 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
                >
                  <Minimize2 className="w-3 h-3" />
                  Restore
                </button>
              </div>
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                <MaxComponent
                  viewport={maximizedVp}
                  isActive
                  isFloating={false}
                  onClose={() => layoutService.closeViewport(maximizedVp.id)}
                />
              </div>
            </div>
          ) : visibleDockRoot ? (
            <>
              {flatDockLayout.groups.map((slot) => {
                const isBottomEdgeSlot = bottomEdgeSlot?.group.id === slot.group.id;
                return (
                  <div
                    key={slot.group.id}
                    data-group-slot={slot.group.id}
                    data-dock-edge={isBottomEdgeSlot ? 'bottom' : undefined}
                    className="absolute flex min-w-0 min-h-0"
                    style={{
                      left: `${slot.left}%`,
                      top: `${slot.top}%`,
                      width: `${slot.width}%`,
                      height: `${slot.height}%`,
                    }}
                  >
                    <DockGroupView
                      group={slot.group}
                      showCompass={hoveredGroupId === slot.group.id}
                      showWorkspaceControls={inlineControlsGroupId === slot.group.id}
                      isMultiGroup={isMultiGroup}
                    />
                  </div>
                );
              })}
              {flatDockLayout.separators.map((sep) => {
                const isBottomEdgeSeparator =
                  Boolean(bottomEdgeSlot) &&
                  sep.direction === 'vertical' &&
                  Math.abs(sep.top - bottomEdgeSlot!.top) <= 0.5 &&
                  Math.abs(sep.left - bottomEdgeSlot!.left) <= 0.5 &&
                  Math.abs(sep.length - bottomEdgeSlot!.width) <= 0.5;
                return (
                  <SplitSeparatorOverlay
                    key={sep.splitId}
                    sep={sep}
                    stageRef={workspaceRef}
                    dockEdge={isBottomEdgeSeparator ? 'bottom' : undefined}
                  />
                );
              })}
            </>
          ) : visibleFloating.length === 0 ? (
            <WorkspaceEmptyView localShellAllowed={localShellAllowed} />
          ) : (
            <div className="flex-1" />
          )}

          {/* Free-Floating Viewports Layer */}
          {!maximizedVp &&
            visibleFloating.map((item) => (
              <FloatingViewportWindow key={item.viewportId} item={item} />
            ))}

          {/* Outer Edge Snap Zones & Translucent Snap Preview while Dragging */}
          {dragState?.active && (
            <>
              {(['left', 'right', 'top', 'bottom'] as DockEdge[]).map((edge) => {
                const active =
                  dragState.snapTarget?.kind === 'edge' && dragState.snapTarget.edge === edge;
                const pos =
                  edge === 'left'
                    ? 'left-0 top-6 bottom-6 w-6'
                    : edge === 'right'
                      ? 'right-0 top-6 bottom-6 w-6'
                      : edge === 'top'
                        ? 'top-0 left-6 right-6 h-6'
                        : 'bottom-0 left-6 right-6 h-6';
                return (
                  <div
                    key={edge}
                    data-drop-edge={edge}
                    aria-label={`Snap Edge ${edge}`}
                    className={`absolute z-40 ${pos} transition-colors ${
                      active
                        ? 'bg-[var(--accent)]/40 border-2 border-[var(--accent)]'
                        : 'bg-[var(--accent)]/10 border border-dashed border-[var(--accent)]/40'
                    }`}
                  />
                );
              })}

              {snapPreviewStyle && (
                <div
                  style={snapPreviewStyle}
                  className="absolute z-30 pointer-events-none bg-[var(--accent)]/15 border-2 border-[var(--accent)] rounded-md transition-all"
                />
              )}
            </>
          )}
        </div>
      </div>

      <SideDrawer side="right" />

      {/* Global Drag Ghost Pill */}
      {dragState?.active && (
        <div
          data-drag-ghost-pill="true"
          style={{ left: dragState.currentX + 12, top: dragState.currentY + 12 }}
          className="fixed z-50 pointer-events-none px-2.5 py-1 rounded-md border border-[var(--accent)] bg-[var(--bg-elevated)]/95 text-xs text-[var(--text-primary)] shadow-lg"
        >
          {dragState.tearOff?.title ??
            (dragState.tearOff ? descriptors[dragState.tearOff.typeId]?.title : undefined) ??
            viewports[dragState.viewportId]?.title ??
            'Viewport'}
        </div>
      )}
    </div>
  );
};
