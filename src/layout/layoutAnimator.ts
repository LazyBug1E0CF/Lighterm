export type LayoutTransitionKind = 'layout' | 'workspace';

interface ExitGhostSnapshot {
  clone: HTMLElement;
  rect: DOMRect;
  viewportId?: string;
  fromTransform: string;
  scrollOffsets: { scrollTop: number; scrollLeft: number }[];
  canvases: HTMLCanvasElement[];
}

export interface LayoutAnimationSnapshot {
  seq: number;
  kind: LayoutTransitionKind;
  workspaceDirection: 1 | -1;
  paneRects: Map<string, DOMRect>;
  groupRects: Map<string, DOMRect>;
  drawerRects: Map<string, DOMRect>;
  tabRects: Map<string, DOMRect>;
  stageGroupCount: number;
  drawerExitSnapshots: Map<'left' | 'right', ExitGhostSnapshot>;
  bottomExitSnapshots: Map<string, ExitGhostSnapshot>;
}

interface ActiveAnimRecord {
  anim: Animation;
  zIndex: string;
  transformOrigin: string;
  onCleanup?: () => void;
}

const FLIP_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
const activeAnimations = new WeakMap<HTMLElement, ActiveAnimRecord>();
const activeExitGhosts = new Map<string, { wrapper: HTMLElement; anim: Animation }>();

let snapshotSeq = 0;
let pendingSnapshot: LayoutAnimationSnapshot | null = null;
let latestSnapshot: LayoutAnimationSnapshot | null = null;

function clearExitGhost(key: string): void {
  const existing = activeExitGhosts.get(key);
  if (!existing) return;
  activeExitGhosts.delete(key);
  try {
    existing.anim.cancel();
  } catch {
    // Ignore animation cancel errors during teardown
  }
  existing.wrapper.remove();
}

function clearAllExitGhosts(): void {
  for (const key of Array.from(activeExitGhosts.keys())) {
    clearExitGhost(key);
  }
}

const GHOST_STRIP_ATTRS = [
  'id',
  'role',
  'aria-label',
  'tabindex',
  'data-flip-id',
  'data-group-container',
  'data-group-slot',
  'data-dock-edge',
  'data-drawer-side',
  'data-drawer-slot',
  'data-drawer-viewport-id',
  'data-drop-drawer',
  'data-drop-group',
  'data-drop-edge',
  'data-flip-tab-id',
  'data-viewport-id',
  'data-viewport-type',
];

function stripGhostAttributes(el: Element): void {
  for (const attr of GHOST_STRIP_ATTRS) {
    el.removeAttribute(attr);
  }
}

function sanitizeGhostClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  stripGhostAttributes(clone);
  clone.setAttribute('aria-hidden', 'true');
  clone.style.pointerEvents = 'none';
  clone.style.userSelect = 'none';
  for (const descendant of clone.querySelectorAll('*')) {
    stripGhostAttributes(descendant);
  }
  return clone;
}

function captureExitSnapshot(
  el: HTMLElement,
  slotSelector: string,
  viewportId?: string,
): ExitGhostSnapshot | null {
  if (typeof el.animate !== 'function') return null;
  const slotEl = el.closest<HTMLElement>(slotSelector);
  const rect = (slotEl ?? el).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const computed =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el).transform
      : 'none';
  const fromTransform = computed && computed !== 'none' ? computed : 'translate3d(0, 0, 0)';
  const scrollOffsets = Array.from(el.querySelectorAll<HTMLElement>('.lighterm-scroll')).map(
    (node) => ({ scrollTop: node.scrollTop, scrollLeft: node.scrollLeft }),
  );
  const canvases = Array.from(el.querySelectorAll('canvas'));

  return {
    clone: sanitizeGhostClone(el),
    rect,
    viewportId,
    fromTransform,
    scrollOffsets,
    canvases,
  };
}

function spawnExitSlideGhost(
  key: string,
  hostEl: HTMLElement,
  entry: ExitGhostSnapshot,
  toTransform: string,
  ghostTag: string,
  addTopHairline = false,
): void {
  clearExitGhost(key);
  if (typeof entry.clone.animate !== 'function') return;

  const hostRect = hostEl.getBoundingClientRect();
  const wrapper = document.createElement('div');
  wrapper.dataset.exitGhost = ghostTag;
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.style.position = 'absolute';
  wrapper.style.left = `${entry.rect.left - hostRect.left}px`;
  wrapper.style.top = `${entry.rect.top - hostRect.top}px`;
  wrapper.style.width = `${entry.rect.width}px`;
  wrapper.style.height = `${entry.rect.height}px`;
  wrapper.style.overflow = 'hidden';
  wrapper.style.pointerEvents = 'none';
  wrapper.style.zIndex = '15';

  entry.clone.style.width = '100%';
  entry.clone.style.height = '100%';
  entry.clone.style.margin = '0';
  entry.clone.style.pointerEvents = 'none';
  if (addTopHairline) {
    entry.clone.style.boxShadow = 'inset 0 1px 0 var(--border-subtle)';
  }

  wrapper.appendChild(entry.clone);
  hostEl.appendChild(wrapper);

  const clonedScrolls = entry.clone.querySelectorAll<HTMLElement>('.lighterm-scroll');
  clonedScrolls.forEach((node, idx) => {
    const saved = entry.scrollOffsets[idx];
    if (saved) {
      node.scrollTop = saved.scrollTop;
      node.scrollLeft = saved.scrollLeft;
    }
  });

  const clonedCanvases = entry.clone.querySelectorAll('canvas');
  clonedCanvases.forEach((dst, idx) => {
    const src = entry.canvases[idx];
    if (!src || src.width <= 0 || src.height <= 0) return;
    try {
      dst.width = src.width;
      dst.height = src.height;
      const ctx = dst.getContext('2d');
      ctx?.drawImage(src, 0, 0);
    } catch {
      // Ignore canvas snapshot errors
    }
  });

  const anim = entry.clone.animate(
    [{ transform: entry.fromTransform }, { transform: toTransform }],
    { duration: 220, easing: FLIP_EASING },
  );

  const record = { wrapper, anim };
  activeExitGhosts.set(key, record);
  const cleanup = () => {
    if (activeExitGhosts.get(key) === record) {
      activeExitGhosts.delete(key);
    }
    wrapper.remove();
  };
  anim.onfinish = cleanup;
  anim.oncancel = cleanup;
}

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

  const drawerExitSnapshots = new Map<'left' | 'right', ExitGhostSnapshot>();
  const bottomExitSnapshots = new Map<string, ExitGhostSnapshot>();
  if (typeof document !== 'undefined') {
    for (const el of document.querySelectorAll<HTMLElement>('[data-drawer-side]')) {
      const side = el.dataset.drawerSide;
      if (side !== 'left' && side !== 'right') continue;
      const exitSnap = captureExitSnapshot(
        el,
        '[data-drawer-slot]',
        el.dataset.drawerViewportId,
      );
      if (exitSnap) {
        drawerExitSnapshots.set(side, exitSnap);
      }
    }

    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-group-slot][data-dock-edge="bottom"] [data-group-container]',
    )) {
      const groupId = el.dataset.groupContainer;
      if (!groupId) continue;
      const exitSnap = captureExitSnapshot(el, '[data-group-slot]', el.dataset.flipId);
      if (exitSnap) {
        bottomExitSnapshots.set(groupId, exitSnap);
      }
    }
  }

  const snap: LayoutAnimationSnapshot = {
    seq: ++snapshotSeq,
    kind,
    workspaceDirection,
    paneRects,
    groupRects,
    drawerRects,
    tabRects: collectRectMap('[data-flip-tab-id]', 'flipTabId'),
    stageGroupCount: groupRects.size,
    drawerExitSnapshots,
    bottomExitSnapshots,
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
  clearAllExitGhosts();
  snapshotSeq = 0;
  pendingSnapshot = null;
  latestSnapshot = null;
}

/** Plays GPU FLIP pane, drawer slide-in/out, bottom slide-up/down, tab-pill, and workspace transitions. */
export function playLayoutAnimation(
  rootEl: HTMLElement | null,
  stageEl: HTMLElement | null,
  snapshot: LayoutAnimationSnapshot | null,
  activeViewportId: string | null,
): void {
  if (!rootEl || !snapshot || prefersReducedMotion()) return;

  if (snapshot.kind === 'workspace') {
    clearAllExitGhosts();
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

  const currentDrawerSides = new Set<string>();
  for (const el of rootEl.querySelectorAll<HTMLElement>('[data-drawer-side]')) {
    if (el.dataset.drawerSide) currentDrawerSides.add(el.dataset.drawerSide);
  }
  const drawerStateChanged =
    currentDrawerSides.size !== snapshot.drawerRects.size ||
    Array.from(currentDrawerSides).some((side) => !snapshot.drawerRects.has(side));
  const currentGroupCount = rootEl.querySelectorAll('[data-group-container]').length;

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

      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        if (!snapshot.paneRects.has(id)) {
          animateStationaryViewportFade(el, id);
        }
        continue;
      }

      if (
        drawerStateChanged &&
        groupId &&
        snapshot.groupRects.has(groupId) &&
        currentGroupCount === snapshot.stageGroupCount
      ) {
        continue;
      }

      animatedContainers.add(el);
      el.style.transformOrigin = '0 0';
      if (!baseStyle.zIndex) {
        el.style.zIndex = id === activeViewportId ? '18' : '12';
      }

      const anim = el.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: 220, easing: FLIP_EASING },
      );
      trackAnimation(el, anim, baseStyle);
    } else {
      if (groupId && snapshot.stageGroupCount === 0) {
        continue;
      }

      animatedContainers.add(el);
      const groupSlotEl = el.closest<HTMLElement>('[data-group-slot]');
      if (groupSlotEl?.dataset.dockEdge === 'bottom' && !snapshot.tabRects.get(id)) {
        clearExitGhost('dock:bottom');
        const prevSlotOverflow = groupSlotEl.style.overflow;
        const prevSlotZIndex = groupSlotEl.style.zIndex;
        groupSlotEl.style.overflow = 'hidden';
        groupSlotEl.style.zIndex = '15';

        const pinnedSlots: Array<{
          el: HTMLElement;
          prevHeight: string;
          pinnedHeight: string;
        }> = [];
        const scopeEl = stageEl ?? rootEl;
        for (const slotEl of scopeEl.querySelectorAll<HTMLElement>('[data-group-slot]')) {
          if (slotEl === groupSlotEl) continue;
          const slotGroupId = slotEl.dataset.groupSlot;
          const prevRect = slotGroupId ? snapshot.groupRects.get(slotGroupId) : undefined;
          if (!prevRect) continue;
          const currRect = slotEl.getBoundingClientRect();
          if (
            currRect.height > 0 &&
            currRect.top + currRect.height <= last.top + 2 &&
            prevRect.height - currRect.height > 1
          ) {
            const pinnedHeight = `${prevRect.height}px`;
            pinnedSlots.push({
              el: slotEl,
              prevHeight: slotEl.style.height,
              pinnedHeight,
            });
            slotEl.style.height = pinnedHeight;
          }
        }

        const bottomSep = scopeEl.querySelector<HTMLElement>(
          '[data-split-separator-edge="bottom"]',
        );
        if (bottomSep && typeof bottomSep.animate === 'function') {
          const sepBaseStyle = cancelAndRestore(bottomSep);
          bottomSep.style.zIndex = '16';
          const sepAnim = bottomSep.animate(
            [
              { transform: `translate3d(0, ${last.height}px, 0)` },
              { transform: 'translate3d(0, 0, 0)' },
            ],
            { duration: 220, easing: FLIP_EASING },
          );
          trackAnimation(bottomSep, sepAnim, sepBaseStyle);
        }

        el.style.transformOrigin = 'bottom center';
        const anim = el.animate(
          [{ transform: 'translate3d(0, 100%, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
          { duration: 220, easing: FLIP_EASING },
        );
        trackAnimation(el, anim, baseStyle, () => {
          groupSlotEl.style.overflow = prevSlotOverflow;
          groupSlotEl.style.zIndex = prevSlotZIndex;
          for (const pinned of pinnedSlots) {
            if (pinned.el.style.height === pinned.pinnedHeight) {
              pinned.el.style.height = pinned.prevHeight;
            }
          }
        });
        continue;
      }

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

    clearExitGhost(`drawer:${side}`);
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

  // Slide out hidden bottom-docked panels and collapsed side drawers via clipped visual exit ghosts.
  const activeFlipIds = new Set<string>();
  for (const el of elements) {
    if (el.dataset.flipId) activeFlipIds.add(el.dataset.flipId);
  }
  const activeGroupIds = new Set<string>();
  for (const el of rootEl.querySelectorAll<HTMLElement>('[data-group-container]')) {
    if (el.dataset.groupContainer) activeGroupIds.add(el.dataset.groupContainer);
  }
  const activeDrawerViewportIds = new Set<string>();
  for (const el of rootEl.querySelectorAll<HTMLElement>('[data-drawer-viewport-id]')) {
    if (el.dataset.drawerViewportId) activeDrawerViewportIds.add(el.dataset.drawerViewportId);
  }
  const hasMaximized = Boolean(rootEl.querySelector('[data-maximized-viewport]'));

  if (stageEl && !hasMaximized && snapshot.bottomExitSnapshots) {
    for (const [groupId, entry] of snapshot.bottomExitSnapshots) {
      if (activeGroupIds.has(groupId)) continue;
      if (
        entry.viewportId &&
        (activeFlipIds.has(entry.viewportId) || activeDrawerViewportIds.has(entry.viewportId))
      ) {
        continue;
      }
      spawnExitSlideGhost(
        'dock:bottom',
        stageEl,
        entry,
        'translate3d(0, 100%, 0)',
        'dock-bottom',
        true,
      );
    }
  }

  if (snapshot.drawerExitSnapshots) {
    for (const [side, entry] of snapshot.drawerExitSnapshots) {
      if (currentDrawerSides.has(side)) continue;
      if (entry.viewportId && activeFlipIds.has(entry.viewportId)) continue;
      const toX = side === 'left' ? '-100%' : '100%';
      spawnExitSlideGhost(
        `drawer:${side}`,
        rootEl,
        entry,
        `translate3d(${toX}, 0, 0)`,
        `drawer-${side}`,
      );
    }
  }

  snapshot.bottomExitSnapshots?.clear();
  snapshot.drawerExitSnapshots?.clear();

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
