import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Minimize2, Plus } from 'lucide-react';
import { shellService } from '../core/shellService';
import { useViewportDescriptors } from '../harness/HarnessContext';
import { DockGroupView } from './DockGroupView';
import { pruneUnavailableViewports } from './dockTree';
import { FloatingViewportWindow } from './FloatingViewportWindow';
import { layoutService, useLayoutStore } from './layoutStore';
import type { DockEdge, DockNode, DockZone, SnapTarget } from './types';

interface DockSplitBranchProps {
  node: DockNode;
  hoveredGroupId: string | null;
}

const DockSplitBranch: React.FC<DockSplitBranchProps> = ({ node, hoveredGroupId }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (node.type === 'group') {
    return <DockGroupView group={node} showCompass={hoveredGroupId === node.id} />;
  }

  const isHorizontal = node.direction === 'horizontal';

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const ratio = isHorizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      layoutService.setSplitRatio(node.id, ratio);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      ref={containerRef}
      className={`flex-1 flex min-w-0 min-h-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      <div
        className="flex min-w-0 min-h-0"
        style={{ flexBasis: `${node.ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}
      >
        <DockSplitBranch node={node.first} hoveredGroupId={hoveredGroupId} />
      </div>

      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        onPointerDown={startResize}
        className={`${
          isHorizontal ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize'
        } shrink-0 bg-[var(--border-subtle)]/80 hover:bg-[var(--accent)] transition-colors`}
      />

      <div className="flex-1 flex min-w-0 min-h-0">
        <DockSplitBranch node={node.second} hoveredGroupId={hoveredGroupId} />
      </div>
    </div>
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

export const WorkspaceCanvas: React.FC = () => {
  const dockRoot = useLayoutStore((s) => s.dockRoot);
  const floating = useLayoutStore((s) => s.floating);
  const viewports = useLayoutStore((s) => s.viewports);
  const maximizedViewportId = useLayoutStore((s) => s.maximizedViewportId);
  const dragState = useLayoutStore((s) => s.dragState);
  const descriptors = useViewportDescriptors();

  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);

  const visibleDockRoot = useMemo(
    () =>
      pruneUnavailableViewports(dockRoot, (vid) => {
        const vp = viewports[vid];
        return Boolean(vp && descriptors[vp.typeId]);
      }),
    [dockRoot, viewports, descriptors],
  );

  const visibleFloating = useMemo(
    () =>
      floating.filter((item) => {
        const vp = viewports[item.viewportId];
        return Boolean(vp && descriptors[vp.typeId]);
      }),
    [floating, viewports, descriptors],
  );

  // Track workspace size for floating clamping
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

  // Global pointer tracking for viewport drag/snap
  const isTrackingDrag = Boolean(dragState);
  useEffect(() => {
    if (!isTrackingDrag) {
      setHoveredGroupId(null);
      return;
    }

    const resolveDropTarget = (x: number, y: number): { snap: SnapTarget | null; groupId: string | null } => {
      const elements =
        typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(x, y)
          : [];

      let snap: SnapTarget | null = null;
      let groupId: string | null = null;

      for (const el of elements) {
        if (!(el instanceof HTMLElement)) continue;
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

    const onMove = (ev: PointerEvent) => {
      const { snap, groupId } = resolveDropTarget(ev.clientX, ev.clientY);
      setHoveredGroupId(groupId);
      layoutService.updateDrag(ev.clientX, ev.clientY, snap);
    };

    const onUp = () => {
      setHoveredGroupId(null);
      layoutService.commitDrag();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setHoveredGroupId(null);
        layoutService.cancelDrag();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isTrackingDrag]);

  const maximizedVp = maximizedViewportId ? viewports[maximizedViewportId] : undefined;
  const maximizedDesc = maximizedVp ? descriptors[maximizedVp.typeId] : undefined;
  const MaxComponent = maximizedDesc?.component;

  const snapPreviewStyle = previewStyleForSnap(dragState?.active ? dragState.snapTarget : null);

  return (
    <div ref={workspaceRef} className="relative flex-1 flex min-w-0 min-h-0 overflow-hidden">
      {/* Maximized Viewport Override */}
      {maximizedVp && MaxComponent ? (
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
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
        <DockSplitBranch node={visibleDockRoot} hoveredGroupId={hoveredGroupId} />
      ) : visibleFloating.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-xs text-[var(--text-muted)]">
          <p>No active viewports. Open a shell connection or enable plugins to compose your workspace.</p>
          <button
            type="button"
            onClick={() => void shellService.createLocalSession()}
            className="h-8 px-3 rounded-md bg-[var(--accent)] text-[#0f111a] font-medium flex items-center gap-1.5 hover:opacity-90"
          >
            <Plus className="w-3.5 h-3.5" />
            New Local Shell
          </button>
        </div>
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

          {/* Drag Ghost Pill */}
          <div
            style={{ left: dragState.currentX + 12, top: dragState.currentY + 12 }}
            className="fixed z-50 pointer-events-none px-2.5 py-1 rounded-md border border-[var(--accent)] bg-[var(--bg-elevated)]/95 text-xs text-[var(--text-primary)] shadow-lg"
          >
            {viewports[dragState.viewportId]?.title ?? 'Viewport'}
          </div>
        </>
      )}
    </div>
  );
};
