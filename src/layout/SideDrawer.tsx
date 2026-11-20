import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  GripVertical,
  PanelLeftClose,
  PanelRightClose,
  PictureInPicture2,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Settings,
  X,
} from 'lucide-react';
import { shellService } from '../core/shellService';
import { useViewportDescriptors } from '../harness/HarnessContext';
import type { ViewportDescriptor } from '../harness/types';
import { animateViewportReveal } from './layoutAnimator';
import { layoutService, useLayoutStore } from './layoutStore';
import type { DrawerSide } from './types';
import { ViewportPositionMenu } from './ViewportPositionMenu';

interface SideDrawerProps {
  side: DrawerSide;
}

export const SideDrawer: React.FC<SideDrawerProps> = ({ side }) => {
  const drawer = useLayoutStore((s) => (side === 'left' ? s.leftDrawer : s.rightDrawer));
  const viewports = useLayoutStore((s) => s.viewports);
  const globalActiveId = useLayoutStore((s) => s.activeViewportId);
  const dragState = useLayoutStore((s) => s.dragState);
  const descriptors = useViewportDescriptors();

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const drawerContentRef = useRef<HTMLDivElement | null>(null);
  const isResizingRef = useRef(false);
  const prevActiveIdRef = useRef<string | null>(globalActiveId);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [addMenuOpen]);

  useEffect(() => {
    if (!drawer.open || !drawer.autoCollapse) return;

    const isProtectedTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return true;
      if (asideRef.current?.contains(target)) return true;
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return true;
      return false;
    };

    const onOutsideInteraction = (e: MouseEvent | FocusEvent) => {
      if (isResizingRef.current || useLayoutStore.getState().dragState?.active) return;
      if (isProtectedTarget(e.target)) return;
      layoutService.autoCollapseDrawer(side);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || addMenuOpen) return;
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return;
      const activeEl = document.activeElement;
      if (activeEl instanceof Node && asideRef.current?.contains(activeEl)) {
        layoutService.autoCollapseDrawer(side);
      }
    };

    window.addEventListener('mousedown', onOutsideInteraction, true);
    window.addEventListener('focusin', onOutsideInteraction, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onOutsideInteraction, true);
      window.removeEventListener('focusin', onOutsideInteraction, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drawer.open, drawer.autoCollapse, side, addMenuOpen]);

  useEffect(() => {
    const prev = prevActiveIdRef.current;
    prevActiveIdRef.current = globalActiveId;
    if (!drawer.open || !drawer.autoCollapse) return;
    if (
      globalActiveId &&
      globalActiveId !== prev &&
      !drawer.viewportIds.includes(globalActiveId)
    ) {
      layoutService.autoCollapseDrawer(side);
    }
  }, [globalActiveId, drawer.open, drawer.autoCollapse, drawer.viewportIds, side]);

  const visibleIds = useMemo(
    () =>
      drawer.viewportIds.filter((id) => {
        const vp = viewports[id];
        return Boolean(vp && descriptors[vp.typeId]);
      }),
    [drawer.viewportIds, viewports, descriptors],
  );

  const activeVpId =
    drawer.activeViewportId && visibleIds.includes(drawer.activeViewportId)
      ? drawer.activeViewportId
      : visibleIds[0] ?? null;
  const activeVp = activeVpId ? viewports[activeVpId] : undefined;
  const activeDesc = activeVp ? descriptors[activeVp.typeId] : undefined;

  const isDraggingAny = Boolean(dragState?.active);
  const isDropTarget =
    Boolean(dragState?.active) &&
    dragState?.snapTarget?.kind === 'drawer' &&
    dragState.snapTarget.side === side;

  const sideLabel = side === 'left' ? 'Left' : 'Right';
  const drawerDockTarget = side === 'left' ? 'left-drawer' : 'right-drawer';

  const handleAddDescriptor = (desc: ViewportDescriptor) => {
    setAddMenuOpen(false);
    if (desc.singleton) {
      const existing = layoutService.findViewportsByType(desc.typeId)[0];
      if (existing) {
        layoutService.dockToDrawer(existing.id, side, true);
      } else {
        layoutService.openViewport({
          typeId: desc.typeId,
          pluginId: desc.pluginId,
          title: desc.title,
          preferredDock: drawerDockTarget,
        });
      }
      return;
    }

    if (desc.typeId === 'terminal.viewport') {
      void shellService.createLocalSession({ meta: { targetDrawer: side } });
      return;
    }

    layoutService.openViewport({
      typeId: desc.typeId,
      pluginId: desc.pluginId,
      title: desc.title,
      preferredDock: drawerDockTarget,
    });
  };

  const movableMultiViewports = useMemo(
    () =>
      Object.values(viewports).filter((vp) => {
        const desc = descriptors[vp.typeId];
        return Boolean(desc && !desc.singleton && !visibleIds.includes(vp.id));
      }),
    [viewports, descriptors, visibleIds],
  );

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = drawer.width;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const nextWidth = side === 'left' ? startWidth + dx : startWidth - dx;
      layoutService.setDrawerWidth(side, nextWidth);
    };

    const onUp = () => {
      isResizingRef.current = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const railElement = (
    <div
      data-drop-drawer={side}
      aria-label={`${sideLabel} Activity Rail`}
      className={`relative z-20 w-11 flex flex-col items-center py-2 gap-1.5 shrink-0 transition-colors ${
        side === 'left' ? 'border-r' : 'border-l'
      } ${isDropTarget ? 'ring-2 ring-inset ring-[var(--accent)] bg-[var(--accent)]/15' : ''}`}
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {visibleIds.map((vid) => {
        const vp = viewports[vid];
        const desc = vp ? descriptors[vp.typeId] : undefined;
        if (!vp || !desc) return null;
        const Icon = desc.icon;
        const active = drawer.open && activeVpId === vp.id;

        return (
          <button
            key={vp.id}
            type="button"
            data-flip-tab-id={vp.id}
            onPointerDown={(e) => {
              if (e.button === 0) {
                layoutService.startDrag(vp.id, 'drawer', e.clientX, e.clientY);
              }
            }}
            onClick={() => {
              const wasOpenOnOther = drawer.open && activeVpId !== vp.id;
              layoutService.selectDrawerViewport(side, vp.id);
              if (wasOpenOnOther) {
                requestAnimationFrame(() =>
                  animateViewportReveal(drawerContentRef.current, vp.id),
                );
              }
            }}
            title={`${vp.title} (Click to toggle / Drag to move)`}
            aria-label={`Switch to ${vp.title}`}
            className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
              active
                ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
            }`}
          >
            <Icon className="w-4 h-4" />
          </button>
        );
      })}

      {/* Add any plugin viewport into this drawer */}
      <div ref={addMenuRef} className="relative">
        <button
          type="button"
          onClick={() => setAddMenuOpen((v) => !v)}
          title={`Add Plugin Viewport to ${sideLabel} Drawer`}
          aria-label={`Add Viewport to ${sideLabel} Drawer`}
          className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)] border border-dashed border-[var(--border-subtle)] transition-colors"
        >
          <Plus className="w-4 h-4" />
        </button>

        {addMenuOpen && (
          <div
            role="menu"
            aria-label={`Add Viewport Menu ${side}`}
            className={`absolute top-0 ${
              side === 'left' ? 'left-full ml-1.5' : 'right-full mr-1.5'
            } z-50 w-52 py-1.5 rounded-lg border shadow-2xl text-xs`}
            style={{
              backgroundColor: 'var(--bg-elevated)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              Add to {sideLabel} Drawer
            </div>
            {Object.values(descriptors).map((desc) => {
              const Icon = desc.icon;
              const existing = desc.singleton
                ? layoutService.findViewportsByType(desc.typeId)[0]
                : undefined;
              const alreadyHere = Boolean(existing && visibleIds.includes(existing.id));

              return (
                <button
                  key={desc.typeId}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAddDescriptor(desc)}
                  className="w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Icon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    <span className="truncate">
                      {desc.typeId === 'terminal.viewport' ? 'New Terminal' : desc.title}
                    </span>
                  </span>
                  {alreadyHere && (
                    <span className="text-[10px] text-[var(--text-muted)] shrink-0">Here</span>
                  )}
                </button>
              );
            })}

            {movableMultiViewports.length > 0 && (
              <>
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Move Existing Here
                </div>
                {movableMultiViewports.map((vp) => {
                  const Icon = descriptors[vp.typeId]?.icon;
                  return (
                    <button
                      key={vp.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAddMenuOpen(false);
                        layoutService.dockToDrawer(vp.id, side, true);
                      }}
                      className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
                    >
                      {Icon && <Icon className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />}
                      <span className="truncate">{vp.title}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1" />

      <button
        type="button"
        onClick={() => layoutService.toggleDrawerAutoCollapse(side)}
        title={
          drawer.autoCollapse
            ? `Auto-Collapse ${sideLabel} Drawer: On (Click to Pin Open)`
            : `Auto-Collapse ${sideLabel} Drawer: Off (Click to Auto-Hide on Blur)`
        }
        aria-label={`Rail Auto-Collapse ${sideLabel} Drawer`}
        aria-pressed={drawer.autoCollapse}
        className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
          drawer.autoCollapse
            ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
        }`}
      >
        {drawer.autoCollapse ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
      </button>

      {side === 'left' && (
        <>
          <button
            type="button"
            onClick={() => shellService.setPluginManagerOpen(true)}
            title="Plugin Manager (Ctrl+Shift+X)"
            aria-label="Rail Manage Plugins"
            className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <Puzzle className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => shellService.setSettingsModalOpen(true)}
            title="Settings"
            aria-label="Open Settings"
            className="w-8 h-8 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  );

  const drawerPanelElement =
    drawer.open && activeVp && activeDesc ? (
      <div data-drawer-slot={side} className="flex h-full shrink-0">
        <div
          data-drawer-side={side}
          data-drop-drawer={side}
          data-drawer-viewport-id={activeVp.id}
          onMouseDown={() => layoutService.setActiveViewport(activeVp.id)}
          style={{
            width: drawer.width,
            backgroundColor: 'var(--bg-surface)',
            borderColor: 'var(--border-subtle)',
          }}
          className={`flex flex-col shrink-0 min-h-0 ${
            side === 'left' ? 'border-r' : 'border-l'
          } ${isDropTarget ? 'ring-2 ring-inset ring-[var(--accent)]' : ''}`}
        >
        {/* Draggable Drawer Header */}
        <div
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('button[data-no-drag="true"]')) return;
            e.preventDefault();
            layoutService.setActiveViewport(activeVp.id);
            layoutService.startDrag(activeVp.id, 'drawer', e.clientX, e.clientY);
          }}
          className="h-9 px-2.5 flex items-center justify-between gap-1 border-b border-[var(--border-subtle)] shrink-0 cursor-grab active:cursor-grabbing select-none"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <GripVertical className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
            <activeDesc.icon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] truncate">
              {activeVp.title}
            </span>
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              data-no-drag="true"
              onClick={() => layoutService.floatViewport(activeVp.id)}
              title="Float Viewport Window"
              aria-label={`Float ${activeVp.title}`}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              <PictureInPicture2 className="w-3 h-3" />
            </button>
            <ViewportPositionMenu viewportId={activeVp.id} />
            <button
              type="button"
              data-no-drag="true"
              onClick={() => layoutService.closeViewport(activeVp.id)}
              title={`Close ${activeVp.title}`}
              aria-label={`Close ${activeVp.title}`}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-elevated)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              data-no-drag="true"
              onClick={() => layoutService.toggleDrawerAutoCollapse(side)}
              title={
                drawer.autoCollapse
                  ? `Auto-Collapse on Blur: On (Click to Pin Open)`
                  : `Auto-Collapse on Blur: Off (Click to Auto-Hide on Blur)`
              }
              aria-label={`Auto-Collapse ${sideLabel} Drawer`}
              aria-pressed={drawer.autoCollapse}
              className={`p-1 rounded transition-colors ${
                drawer.autoCollapse
                  ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
              }`}
            >
              {drawer.autoCollapse ? (
                <PinOff className="w-3 h-3" />
              ) : (
                <Pin className="w-3 h-3" />
              )}
            </button>
            <button
              type="button"
              data-no-drag="true"
              onClick={() => layoutService.setDrawerOpen(side, false)}
              title={`Collapse ${sideLabel} Drawer`}
              aria-label={`Collapse ${sideLabel} Drawer`}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
            >
              {side === 'left' ? (
                <PanelLeftClose className="w-3.5 h-3.5" />
              ) : (
                <PanelRightClose className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Rendered Drawer Viewports */}
        <div
          ref={drawerContentRef}
          className={`flex-1 flex flex-col min-h-0 overflow-hidden ${
            isDraggingAny ? 'pointer-events-none' : ''
          }`}
        >
          {visibleIds.map((vid) => {
            const vp = viewports[vid];
            const desc = vp ? descriptors[vp.typeId] : undefined;
            if (!vp || !desc) return null;
            const Component = desc.component;
            const visible = vp.id === activeVp.id;
            return (
              <div
                key={vp.id}
                data-viewport-id={vp.id}
                data-viewport-type={vp.typeId}
                className={visible ? 'flex-1 flex flex-col min-w-0 min-h-0' : 'hidden'}
              >
                <Component
                  viewport={vp}
                  isActive={visible && globalActiveId === vp.id}
                  isFloating={false}
                  onClose={() => layoutService.closeViewport(vp.id)}
                />
              </div>
            );
          })}
        </div>
        </div>
      </div>
    ) : null;

  const resizeSash =
    drawer.open && activeVp ? (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${sideLabel} Drawer`}
        onPointerDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-[var(--accent)] transition-colors"
      />
    ) : null;

  return (
    <aside
      ref={asideRef}
      aria-label={`${sideLabel} Side Drawer`}
      className="flex shrink-0 h-full select-none"
    >
      {side === 'left' ? (
        <>
          {railElement}
          {drawerPanelElement}
          {resizeSash}
        </>
      ) : (
        <>
          {resizeSash}
          {drawerPanelElement}
          {railElement}
        </>
      )}
    </aside>
  );
};
