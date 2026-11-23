import type { MonitorPanelId } from './monitorPanelStore';

export interface PanelBaseRect {
  id: MonitorPanelId;
  top: number;
  bottom: number;
  height: number;
}

/**
 * Measures vertical spacing between adjacent cards from initial static rects.
 */
export function measurePanelGap(baseRects: readonly PanelBaseRect[], fallback = 12): number {
  if (baseRects.length < 2) return fallback;
  const measured = baseRects[1].top - baseRects[0].bottom;
  return Number.isFinite(measured) && measured >= 0 ? measured : fallback;
}

/**
 * Computes the optimal destination index (0..n-1) using static drag-start geometry
 * so mixed-height cards never oscillate while sibling CSS transforms are animating.
 */
export function computeDragTargetIndex(
  baseRects: readonly PanelBaseRect[],
  fromIndex: number,
  ghostCenterY: number,
  gap: number,
): number {
  const count = baseRects.length;
  if (count <= 1 || fromIndex < 0 || fromIndex >= count) {
    return Math.max(0, fromIndex);
  }

  const dragged = baseRects[fromIndex];
  const others = baseRects.filter((_, i) => i !== fromIndex);

  let cursorY = baseRects[0].top;
  let bestIndex = fromIndex;
  let bestDist = Infinity;

  for (let k = 0; k < count; k += 1) {
    const candidateCenter = cursorY + dragged.height / 2;
    const dist = Math.abs(ghostCenterY - candidateCenter);
    if (dist < bestDist) {
      bestDist = dist;
      bestIndex = k;
    }
    if (k < others.length) {
      cursorY += others[k].height + gap;
    }
  }

  return bestIndex;
}

/**
 * Computes exact pixel Y displacement for a card at `index` when the dragged card
 * at `fromIndex` previews moving to `targetIndex`.
 */
export function computeCardDisplacementY(
  baseRects: readonly PanelBaseRect[],
  fromIndex: number,
  targetIndex: number,
  index: number,
  gap: number,
): number {
  if (
    fromIndex === targetIndex ||
    fromIndex < 0 ||
    fromIndex >= baseRects.length ||
    targetIndex < 0 ||
    targetIndex >= baseRects.length ||
    index < 0 ||
    index >= baseRects.length
  ) {
    return 0;
  }

  const draggedShift = baseRects[fromIndex].height + gap;

  if (index === fromIndex) {
    let shift = 0;
    if (targetIndex > fromIndex) {
      for (let j = fromIndex + 1; j <= targetIndex; j += 1) {
        shift += baseRects[j].height + gap;
      }
    } else {
      for (let j = targetIndex; j < fromIndex; j += 1) {
        shift -= baseRects[j].height + gap;
      }
    }
    return shift;
  }

  if (targetIndex > fromIndex && index > fromIndex && index <= targetIndex) {
    return -draggedShift;
  }

  if (targetIndex < fromIndex && index >= targetIndex && index < fromIndex) {
    return draggedShift;
  }

  return 0;
}
