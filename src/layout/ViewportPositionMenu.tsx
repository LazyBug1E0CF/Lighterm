import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Maximize2,
  Minimize2,
  Move,
  PanelLeft,
  PanelRight,
  PictureInPicture2,
} from 'lucide-react';
import { layoutService, useLayoutStore } from './layoutStore';
import type { DockEdge } from './types';

interface ViewportPositionMenuProps {
  viewportId: string;
  isFloating?: boolean;
}

export const ViewportPositionMenu: React.FC<ViewportPositionMenuProps> = ({ viewportId }) => {
  const [open, setOpen] = useState(false);
  const maximizedViewportId = useLayoutStore((s) => s.maximizedViewportId);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const dockEdge = (edge: DockEdge) => {
    layoutService.dockToEdge(viewportId, edge);
    setOpen(false);
  };

  const location = layoutService.getViewportLocation(viewportId);
  const isMaximized = maximizedViewportId === viewportId;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Move / Dock / Drawer / Float Viewport"
        aria-label="Position Viewport"
        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
      >
        <Move className="w-3 h-3" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Viewport Position Options"
          onClick={(e) => e.stopPropagation()}
          className="lighterm-pop-enter absolute right-0 top-full mt-1 z-50 w-48 py-1 rounded-lg border shadow-xl text-xs"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          {location !== 'left-drawer' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                layoutService.dockToDrawer(viewportId, 'left');
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              <PanelLeft className="w-3.5 h-3.5 text-[var(--accent)]" />
              Move to Left Drawer
            </button>
          )}
          {location !== 'right-drawer' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                layoutService.dockToDrawer(viewportId, 'right');
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              <PanelRight className="w-3.5 h-3.5 text-[var(--accent)]" />
              Move to Right Drawer
            </button>
          )}
          {location !== 'floating' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                layoutService.floatViewport(viewportId);
                setOpen(false);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              <PictureInPicture2 className="w-3.5 h-3.5 text-[var(--accent)]" />
              Float Window
            </button>
          )}
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => dockEdge('left')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <ArrowLeftToLine className="w-3.5 h-3.5" />
            Dock Left
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dockEdge('right')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <ArrowRightToLine className="w-3.5 h-3.5" />
            Dock Right
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dockEdge('top')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <ArrowUpToLine className="w-3.5 h-3.5" />
            Dock Top
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => dockEdge('bottom')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <ArrowDownToLine className="w-3.5 h-3.5" />
            Dock Bottom
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              layoutService.toggleMaximize(viewportId);
              setOpen(false);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            {isMaximized ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" />
                Restore Size
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" />
                Maximize
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
