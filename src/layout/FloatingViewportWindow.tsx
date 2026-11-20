import React from 'react';
import { GripHorizontal, X } from 'lucide-react';
import { useViewportDescriptors } from '../harness/HarnessContext';
import { layoutService, useLayoutStore } from './layoutStore';
import type { FloatingViewportItem } from './types';
import { ViewportPositionMenu } from './ViewportPositionMenu';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';

const RESIZE_HANDLES: { dir: ResizeDir; className: string }[] = [
  { dir: 'n', className: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { dir: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { dir: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { dir: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { dir: 'nw', className: 'top-0 left-0 w-2.5 h-2.5 cursor-nwse-resize' },
  { dir: 'ne', className: 'top-0 right-0 w-2.5 h-2.5 cursor-nesw-resize' },
  { dir: 'sw', className: 'bottom-0 left-0 w-2.5 h-2.5 cursor-nesw-resize' },
  { dir: 'se', className: 'bottom-0 right-0 w-2.5 h-2.5 cursor-nwse-resize' },
];

export const FloatingViewportWindow: React.FC<{ item: FloatingViewportItem }> = ({ item }) => {
  const viewport = useLayoutStore((s) => s.viewports[item.viewportId]);
  const activeViewportId = useLayoutStore((s) => s.activeViewportId);
  const dragState = useLayoutStore((s) => s.dragState);
  const descriptors = useViewportDescriptors();

  if (!viewport) return null;
  const desc = descriptors[viewport.typeId];
  if (!desc) return null;

  const Icon = desc.icon;
  const Component = desc.component;
  const isActive = activeViewportId === viewport.id;
  const isDraggingAny = Boolean(dragState?.active);

  const startHeaderDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button[data-no-drag="true"]')) return;
    e.preventDefault();
    layoutService.setActiveViewport(viewport.id);
    layoutService.startDrag(
      viewport.id,
      'floating',
      e.clientX,
      e.clientY,
      e.clientX - item.x,
      e.clientY - item.y,
    );
  };

  const startResize = (dir: ResizeDir, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    layoutService.setActiveViewport(viewport.id);

    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = { x: item.x, y: item.y, width: item.width, height: item.height };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      let { x, y, width, height } = startRect;
      if (dir.includes('e')) width = startRect.width + dx;
      if (dir.includes('s')) height = startRect.height + dy;
      if (dir.includes('w')) {
        const nextW = Math.max(280, startRect.width - dx);
        x = startRect.x + (startRect.width - nextW);
        width = nextW;
      }
      if (dir.includes('n')) {
        const nextH = Math.max(180, startRect.height - dy);
        y = Math.max(0, startRect.y + (startRect.height - nextH));
        height = nextH;
      }

      layoutService.resizeFloating(viewport.id, { x, y, width, height });
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
      role="region"
      aria-label={`Floating ${viewport.title}`}
      data-floating-viewport={viewport.id}
      data-flip-id={viewport.id}
      onMouseDown={() => layoutService.setActiveViewport(viewport.id)}
      style={{
        left: item.x,
        top: item.y,
        width: item.width,
        height: item.height,
        zIndex: item.zIndex,
        backgroundColor: 'var(--bg-surface)',
      }}
      className={`absolute flex flex-col rounded-xl border shadow-2xl overflow-hidden ${
        isActive ? 'border-[var(--accent)]/80' : 'border-[var(--border-subtle)]'
      }`}
    >
      {/* Floating Drag Header */}
      <div
        onPointerDown={startHeaderDrag}
        className="h-8 px-2.5 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0 cursor-move select-none"
        style={{ backgroundColor: 'var(--bg-elevated)' }}
      >
        <div className="flex items-center gap-1.5 min-w-0 text-xs font-medium text-[var(--text-primary)]">
          <GripHorizontal className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <Icon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
          <span className="truncate">{viewport.title}</span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <ViewportPositionMenu viewportId={viewport.id} />
          <button
            type="button"
            data-no-drag="true"
            aria-label={`Close ${viewport.title}`}
            onClick={(e) => {
              e.stopPropagation();
              layoutService.closeViewport(viewport.id);
            }}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div
        className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${
          isDraggingAny ? 'pointer-events-none' : ''
        }`}
      >
        <Component
          viewport={viewport}
          isActive={isActive}
          isFloating
          onClose={() => layoutService.closeViewport(viewport.id)}
        />
      </div>

      {/* 8-Direction Resize Handles */}
      {RESIZE_HANDLES.map((h) => (
        <div
          key={h.dir}
          data-resize-handle={h.dir}
          onPointerDown={(e) => startResize(h.dir, e)}
          className={`absolute z-20 ${h.className}`}
        />
      ))}
    </div>
  );
};
