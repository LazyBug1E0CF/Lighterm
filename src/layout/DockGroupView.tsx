import React, { useRef } from 'react';
import { GripVertical, Layers, PictureInPicture2, Search, X } from 'lucide-react';
import { useShellStore } from '../core/shellService';
import { useHarness, useViewportDescriptors } from '../harness/HarnessContext';
import {
  TERMINAL_VIEWPORT_TYPE,
  type TerminalPluginService,
} from '../plugins/terminal/terminalService';
import { animateViewportReveal } from './layoutAnimator';
import { layoutService, useLayoutStore } from './layoutStore';
import { NewShellButton, QuickShellLayoutButtons } from './QuickShellLayoutBar';
import type { DockGroupNode, DockZone } from './types';
import { ViewportPositionMenu } from './ViewportPositionMenu';

interface DockGroupViewProps {
  group: DockGroupNode;
  showCompass: boolean;
  showWorkspaceControls?: boolean;
}

const COMPASS_ZONES: {
  zone: DockZone;
  label: string;
  posClass: string;
}[] = [
  { zone: 'top', label: 'Top', posClass: 'top-1 left-1/2 -translate-x-1/2' },
  { zone: 'left', label: 'Left', posClass: 'left-1 top-1/2 -translate-y-1/2' },
  { zone: 'center', label: 'Tab', posClass: 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2' },
  { zone: 'right', label: 'Right', posClass: 'right-1 top-1/2 -translate-y-1/2' },
  { zone: 'bottom', label: 'Bottom', posClass: 'bottom-1 left-1/2 -translate-x-1/2' },
];

export const DockGroupView: React.FC<DockGroupViewProps> = ({
  group,
  showCompass,
  showWorkspaceControls = false,
}) => {
  const viewports = useLayoutStore((s) => s.viewports);
  const globalActiveId = useLayoutStore((s) => s.activeViewportId);
  const dragState = useLayoutStore((s) => s.dragState);
  const sessions = useShellStore((s) => s.sessions);
  const sessionStatuses = useShellStore((s) => s.sessionStatuses);
  const descriptors = useViewportDescriptors();
  const harness = useHarness();
  const termService = harness.getService<TerminalPluginService>('terminal:service');
  const contentHostRef = useRef<HTMLDivElement | null>(null);

  const activeVp = viewports[group.activeViewportId] ?? viewports[group.viewportIds[0]];
  const isGroupFocused = activeVp ? globalActiveId === activeVp.id : false;
  const isDraggingAny = Boolean(dragState?.active);

  const startTabDrag = (e: React.PointerEvent, viewportId: string) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button[data-no-drag="true"]')) return;
    e.preventDefault();
    layoutService.setActiveViewport(viewportId);
    layoutService.startDrag(viewportId, 'docked', e.clientX, e.clientY);
  };

  return (
    <div
      data-group-container={group.id}
      data-flip-id={activeVp?.id}
      onMouseDown={() => {
        if (activeVp) layoutService.setActiveViewport(activeVp.id);
      }}
      className={`relative flex-1 flex flex-col min-w-0 min-h-0 border transition-colors ${
        isGroupFocused ? 'border-[var(--accent)]/60' : 'border-[var(--border-subtle)]/50'
      }`}
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      {/* Draggable Tab / Viewport Header Bar */}
      <div
        data-drop-group={group.id}
        data-drop-zone="center"
        className="h-8 px-1.5 flex items-center justify-between gap-1 border-b border-[var(--border-subtle)] shrink-0 select-none"
        style={{ backgroundColor: 'var(--bg-surface)' }}
      >
        <div className="flex-1 flex items-center gap-1 overflow-x-auto lighterm-scroll min-w-0">
          {group.viewportIds.map((vid) => {
            const vp = viewports[vid];
            if (!vp) return null;
            const desc = descriptors[vp.typeId];
            if (!desc) return null;
            const Icon = desc.icon;
            const isTabActive = vp.id === activeVp?.id;

            let dotColor: string | null = null;
            if (vp.typeId === TERMINAL_VIEWPORT_TYPE) {
              const sid = String(vp.params?.sessionId ?? '');
              const status = sessionStatuses[sid] ?? sessions[sid]?.info.status ?? 'connected';
              dotColor =
                status === 'connected'
                  ? 'var(--success)'
                  : status === 'connecting'
                    ? 'var(--warning)'
                    : status === 'error'
                      ? 'var(--danger)'
                      : 'var(--text-muted)';
            }

            return (
              <div
                key={vp.id}
                role="tab"
                aria-selected={isTabActive}
                data-flip-tab-id={vp.id}
                onPointerDown={(e) => startTabDrag(e, vp.id)}
                onClick={() => {
                  layoutService.selectGroupTab(group.id, vp.id);
                  if (!isTabActive) {
                    requestAnimationFrame(() =>
                      animateViewportReveal(contentHostRef.current, vp.id),
                    );
                  }
                }}
                className={`group flex items-center gap-1.5 h-6 px-2 rounded text-xs cursor-grab active:cursor-grabbing shrink-0 max-w-[190px] border transition-colors ${
                  isTabActive
                    ? 'bg-[var(--bg-elevated)] border-[var(--accent)]/40 text-[var(--text-primary)] font-medium'
                    : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-elevated)]/60 hover:text-[var(--text-primary)]'
                }`}
              >
                <GripVertical className="w-3 h-3 opacity-40 group-hover:opacity-90 shrink-0" />
                {dotColor && (
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: dotColor }}
                  />
                )}
                <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />
                <span className="truncate">{vp.title}</span>
                <button
                  type="button"
                  data-no-drag="true"
                  aria-label={`Close ${vp.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    layoutService.closeViewport(vp.id);
                  }}
                  className="ml-0.5 p-0.5 rounded opacity-50 group-hover:opacity-100 hover:bg-white/10 hover:text-[var(--danger)]"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}

          {showWorkspaceControls && <NewShellButton />}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {showWorkspaceControls && <QuickShellLayoutButtons />}

          {activeVp && (
            <div className="flex items-center gap-0.5 shrink-0">
              {activeVp.typeId === TERMINAL_VIEWPORT_TYPE && termService && (
                <button
                  type="button"
                  data-no-drag="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    layoutService.setActiveViewport(activeVp.id);
                    termService.triggerSearch();
                  }}
                  title="Find in Terminal (Ctrl+Shift+F)"
                  aria-label="Find in terminal"
                  className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
                >
                  <Search className="w-3 h-3" />
                </button>
              )}
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
            </div>
          )}
        </div>
      </div>

      {/* Viewport Content Host */}
      <div
        ref={contentHostRef}
        className={`flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden ${
          isDraggingAny ? 'pointer-events-none' : ''
        }`}
      >
        {group.viewportIds.map((vid) => {
          const vp = viewports[vid];
          if (!vp) return null;
          const desc = descriptors[vp.typeId];
          if (!desc) return null;
          const Component = desc.component;
          const visible = vp.id === activeVp?.id;

          return (
            <div
              key={vp.id}
              data-viewport-id={vp.id}
              data-viewport-type={vp.typeId}
              className={visible ? 'flex-1 flex flex-col min-w-0 min-h-0' : 'hidden'}
            >
              <Component
                viewport={vp}
                isActive={visible && isGroupFocused}
                isFloating={false}
                onClose={() => layoutService.closeViewport(vp.id)}
              />
            </div>
          );
        })}
      </div>

      {/* 5-Zone Dock Compass Overlay while dragging */}
      {isDraggingAny && showCompass && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/25 pointer-events-none">
          <div
            className="lighterm-pop-enter relative w-36 h-36 rounded-xl border border-[var(--border-subtle)] shadow-2xl pointer-events-auto"
            style={{ backgroundColor: 'var(--bg-elevated)' }}
          >
            {COMPASS_ZONES.map((item) => {
              const isSelected =
                dragState?.snapTarget?.kind === 'group' &&
                dragState.snapTarget.groupId === group.id &&
                dragState.snapTarget.zone === item.zone;
              return (
                <div
                  key={item.zone}
                  data-drop-group={group.id}
                  data-drop-zone={item.zone}
                  aria-label={`Dock ${item.label}`}
                  className={`absolute ${item.posClass} w-10 h-10 rounded-lg border flex flex-col items-center justify-center text-[10px] font-medium transition-colors ${
                    isSelected
                      ? 'bg-[var(--accent)] text-[#0f111a] border-[var(--accent)]'
                      : 'bg-[var(--bg-surface)] text-[var(--text-primary)] border-[var(--border-subtle)] hover:border-[var(--accent)]'
                  }`}
                >
                  {item.zone === 'center' && <Layers className="w-3 h-3 mb-0.5" />}
                  <span>{item.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
