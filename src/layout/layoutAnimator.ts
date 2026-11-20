export type LayoutTransitionKind = 'layout' | 'workspace';

export interface LayoutAnimationSnapshot {
  seq: number;
  kind: LayoutTransitionKind;
  workspaceDirection: 1 | -1;
  paneRects: Map<string, DOMRect>;
  groupRects: Map<string, DOMRect>;
  drawerRects: Map<string, DOMRect>;
  tabRects: Map<string, DOMRect>;
  stageGroupCount: number;
}

interface ActiveAnimRecord {
  anim: Animation;
  zIndex: string;
  transformOrigin: string;
  onCleanup?: () => void;
}

const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const activeAnimations = new WeakMap<HTMLElement, ActiveAnimRecord>();

let snapshotSeq = 0;
let pendingSnapshot: LayoutAnimationSnapshot | null = null;
let latestSnapshot: LayoutAnimationSnapshot | null = null;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function collectRectMap(
  selector: string,
  attrName: 'flipId' | 'groupContainer' | 'flipTabId' | 'drawerSide' | 'drawerViewportId',
): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  if (typeof document === 'undefined') return map;
  const nodes = document.querySelectorAll<HTMLElement>(selector);
  for (const el of nodes) {
    const id = el.dataset[attrName];
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      map.set(id, rect);
    }
  }
  return map;
}

function cancelAndRestore(el: HTMLElement): { zIndex: string; transformOrigin: string } {
  const existing = activeAnimations.get(el);
  if (!existing) {
    return { zIndex: el.style.zIndex, transformOrigin: el.style.transformOrigin };
  }
  activeAnimations.delete(el);
  existing.anim.cancel();
  el.style.zIndex = existing.zIndex;
  el.style.transformOrigin = existing.transformOrigin;
  existing.onCleanup?.();
  return { zIndex: existing.zIndex, transformOrigin: existing.transformOrigin };
}

function trackAnimation(
  el: HTMLElement,
  anim: Animation,
  baseStyle: { zIndex: string; transformOrigin: string },
  onCleanup?: () => void,
): void {
  activeAnimations.set(el, { anim, ...baseStyle, onCleanup });
  const cleanup = () => {
    const current = activeAnimations.get(el);
    if (current?.anim === anim) {
      activeAnimations.delete(el);
      el.style.zIndex = baseStyle.zIndex;
      el.style.transformOrigin = baseStyle.transformOrigin;
      onCleanup?.();
    }
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}

function animateStationaryViewportFade(containerEl: HTMLElement, viewportId: string): void {
  const inner = Array.from(containerEl.querySelectorAll<HTMLElement>('[data-viewport-id]')).find(
    (node) => node.dataset.viewportId === viewportId,
  );
  if (!inner || typeof inner.animate !== 'function') return;
  const baseStyle = cancelAndRestore(inner);
  const anim = inner.animate([{ opacity: 0.7 }, { opacity: 1 }], {
    duration: 120,
    easing: FLIP_EASING,
  });
  trackAnimation(inner, anim, baseStyle);
}

/** Captures current layout pane, group, drawer, and tab screen rects before a discrete change. */
export function captureLayoutSnapshot(
  kind: LayoutTransitionKind = 'layout',
  workspaceDirection: 1 | -1 = 1,
): LayoutAnimationSnapshot {
  if (pendingSnapshot) {
    if (kind === 'workspace' && pendingSnapshot.kind !== 'workspace') {
      pendingSnapshot.kind = 'workspace';
      pendingSnapshot.workspaceDirection = workspaceDirection;
    }
    return pendingSnapshot;
  }

  const paneRects = collectRectMap('[data-flip-id]', 'flipId');
  const drawerViewportRects = collectRectMap('[data-drawer-viewport-id]', 'drawerViewportId');
  for (const [id, rect] of drawerViewportRects) {
    if (!paneRects.has(id)) {
      paneRects.set(id, rect);
    }
  }

  const groupRects = collectRectMap('[data-group-container]', 'groupContainer');
  const drawerRects = collectRectMap('[data-drawer-side]', 'drawerSide');
  const snap: LayoutAnimationSnapshot = {
    seq: ++snapshotSeq,
    kind,
    workspaceDirection,
    paneRects,
    groupRects,
    drawerRects,
    tabRects: collectRectMap('[data-flip-tab-id]', 'flipTabId'),
    stageGroupCount: groupRects.size,
  };

  pendingSnapshot = snap;
  latestSnapshot = snap;

  queueMicrotask(() => {
    if (pendingSnapshot === snap) {
      pendingSnapshot = null;
    }
  });

  return snap;
}

export function getLatestLayoutSnapshot(): LayoutAnimationSnapshot | null {
  return latestSnapshot;
}

export function resetLayoutAnimatorForTesting(): void {
  snapshotSeq = 0;
  pendingSnapshot = null;
  latestSnapshot = null;
}

/** Plays GPU FLIP pane, drawer slide-out, tab-pill, and workspace transitions. */
export function playLayoutAnimation(
  rootEl: HTMLElement | null,
  stageEl: HTMLElement | null,
  snapshot: LayoutAnimationSnapshot | null,
  activeViewportId: string | null,
): void {
  if (!rootEl || !snapshot || prefersReducedMotion()) return;

  if (snapshot.kind === 'workspace') {
    if (stageEl && typeof stageEl.animate === 'function') {
      const baseStyle = cancelAndRestore(stageEl);
      const anim = stageEl.animate(
        [
          {
            opacity: 0.35,
            transform: `translate3d(${snapshot.workspaceDirection * 20}px, 0, 0)`,
          },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 210, easing: FLIP_EASING },
      );
      trackAnimation(stageEl, anim, baseStyle);
    }
    return;
  }

  // Skip initial cold-start fade before any panes or drawers exist on screen.
  if (
    snapshot.paneRects.size === 0 &&
    snapshot.groupRects.size === 0 &&
    snapshot.drawerRects.size === 0 &&
    snapshot.tabRects.size === 0
  ) {
    return;
  }

  const animatedContainers = new Set<HTMLElement>();
  const elements = rootEl.querySelectorAll<HTMLElement>('[data-flip-id]');

  for (const el of elements) {
    const id = el.dataset.flipId;
    if (!id || typeof el.animate !== 'function') continue;

    const groupId = el.dataset.groupContainer;
    const baseStyle = cancelAndRestore(el);
    const last = el.getBoundingClientRect();
    if (last.width <= 0 || last.height <= 0) continue;

    const first =
      snapshot.paneRects.get(id) ?? (groupId ? snapshot.groupRects.get(groupId) : undefined);

    if (first) {
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sx = first.width / last.width;
      const sy = first.height / last.height;

      if (
        Math.abs(dx) < 1 &&
        Math.abs(dy) < 1 &&
        Math.abs(sx - 1) < 0.01 &&
        Math.abs(sy - 1) < 0.01
      ) {
        if (!snapshot.paneRects.has(id)) {
          animateStationaryViewportFade(el, id);
        }
        continue;
      }

      animatedContainers.add(el);
      el.style.transformOrigin = '0 0';
      if (!baseStyle.zIndex) {
        el.style.zIndex = id === activeViewportId ? '18' : '12';
      }

      const anim = el.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})` },
          { transform: 'translate3d(0, 0, 0) scale(1, 1)' },
        ],
        { duration: 260, easing: FLIP_EASING },
      );
      trackAnimation(el, anim, baseStyle);
    } else {
      if (groupId && snapshot.stageGroupCount === 0) {
        continue;
      }

      animatedContainers.add(el);
      const tabRect = snapshot.tabRects.get(id);
      let dx = 0;
      let dy = 0;
      if (tabRect) {
        const tabCenterX = tabRect.left + tabRect.width / 2;
        const tabCenterY = tabRect.top + tabRect.height / 2;
        const lastCenterX = last.left + last.width / 2;
        const lastCenterY = last.top + last.height / 2;
        dx = clamp((tabCenterX - lastCenterX) * 0.12, -36, 36);
        dy = clamp((tabCenterY - lastCenterY) * 0.12, -36, 36);
      }

      el.style.transformOrigin = 'center center';
      const anim = el.animate(
        [
          { opacity: 0.45, transform: `translate3d(${dx}px, ${dy}px, 0) scale(0.96)` },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        ],
        { duration: 200, easing: FLIP_EASING },
      );
      trackAnimation(el, anim, baseStyle);
    }
  }

  // Slide newly opened Side Drawers cleanly out from their matching screen edge.
  const drawerElements = rootEl.querySelectorAll<HTMLElement>('[data-drawer-side]');
  for (const el of drawerElements) {
    const side = el.dataset.drawerSide;
    if ((side !== 'left' && side !== 'right') || typeof el.animate !== 'function') continue;
    if (snapshot.drawerRects.has(side)) continue;

    const baseStyle = cancelAndRestore(el);
    const last = el.getBoundingClientRect();
    if (last.width <= 0 || last.height <= 0) continue;

    const slotEl = el.closest<HTMLElement>('[data-drawer-slot]');
    const prevSlotOverflow = slotEl ? slotEl.style.overflow : '';
    if (slotEl) {
      slotEl.style.overflow = 'hidden';
    }

    const fromX = side === 'left' ? '-100%' : '100%';
    const anim = el.animate(
      [{ transform: `translate3d(${fromX}, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 220, easing: FLIP_EASING },
    );
    trackAnimation(el, anim, baseStyle, () => {
      if (slotEl) {
        slotEl.style.overflow = prevSlotOverflow;
      }
    });
  }

  // Animate tab pills horizontally in stationary tab bars when adding or closing tabs.
  const tabElements = rootEl.querySelectorAll<HTMLElement>('[data-flip-tab-id]');
  for (const el of tabElements) {
    const tabId = el.dataset.flipTabId;
    if (!tabId || typeof el.animate !== 'function') continue;
    if (el.closest('[data-drop-drawer]')) continue;

    const parentPane = el.closest<HTMLElement>('[data-flip-id]');
    if (parentPane && animatedContainers.has(parentPane)) continue;

    const baseStyle = cancelAndRestore(el);
    const last = el.getBoundingClientRect();
    if (last.width <= 0 || last.height <= 0) continue;

    const prevTab = snapshot.tabRects.get(tabId);
    if (prevTab) {
      const dx = prevTab.left - last.left;
      const dy = prevTab.top - last.top;
      if (Math.abs(dy) < 6 && Math.abs(dx) >= 2) {
        const anim = el.animate(
          [
            { transform: `translate3d(${dx}px, 0, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          { duration: 180, easing: FLIP_EASING },
        );
        trackAnimation(el, anim, baseStyle);
      }
    } else if (snapshot.tabRects.size > 0) {
      const anim = el.animate(
        [
          { opacity: 0, transform: 'translate3d(-10px, 0, 0) scale(0.94)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        ],
        { duration: 170, easing: FLIP_EASING },
      );
      trackAnimation(el, anim, baseStyle);
    }
  }
}

/** Subtle vertical reveal animation when switching tabs inside a single dock group or drawer. */
export function animateViewportReveal(hostEl: HTMLElement | null, viewportId: string): void {
  if (!hostEl || !viewportId || prefersReducedMotion()) return;
  const el = Array.from(hostEl.querySelectorAll<HTMLElement>('[data-viewport-id]')).find(
    (node) => node.dataset.viewportId === viewportId,
  );
  if (!el || typeof el.animate !== 'function') return;

  const baseStyle = cancelAndRestore(el);
  const anim = el.animate(
    [
      { opacity: 0.35, transform: 'translate3d(0, 4px, 0)' },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ],
    { duration: 150, easing: FLIP_EASING },
  );
  trackAnimation(el, anim, baseStyle);
}
