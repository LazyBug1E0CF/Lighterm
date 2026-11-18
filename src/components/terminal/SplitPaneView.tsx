import React, { useRef } from 'react';
import { useAppStore } from '../../store/useAppStore';
import type { PaneNode } from '../../types';
import { TerminalPane } from './TerminalPane';

interface SplitPaneViewProps {
  tabId: string;
  node: PaneNode;
  activePaneId: string;
  isTabActive: boolean;
}

export const SplitPaneView: React.FC<SplitPaneViewProps> = ({
  tabId,
  node,
  activePaneId,
  isTabActive,
}) => {
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (node.type === 'leaf') {
    return (
      <TerminalPane
        tabId={tabId}
        pane={node}
        isActivePane={node.id === activePaneId}
        isTabActive={isTabActive}
      />
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const onMove = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const ratio = isHorizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      setSplitRatio(tabId, node.id, ratio);
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
        <SplitPaneView
          tabId={tabId}
          node={node.first}
          activePaneId={activePaneId}
          isTabActive={isTabActive}
        />
      </div>

      <div
        onPointerDown={startDrag}
        className={`${
          isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        } shrink-0 bg-[var(--border-subtle)] hover:bg-[var(--accent)] transition-colors`}
      />

      <div className="flex-1 flex min-w-0 min-h-0">
        <SplitPaneView
          tabId={tabId}
          node={node.second}
          activePaneId={activePaneId}
          isTabActive={isTabActive}
        />
      </div>
    </div>
  );
};
