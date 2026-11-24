import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  animateViewportReveal,
  captureLayoutSnapshot,
  playLayoutAnimation,
  resetLayoutAnimatorForTesting,
} from '../layout/layoutAnimator';
import { layoutService, useLayoutStore } from '../layout/layoutStore';

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function attachMockAnimate(el: HTMLElement) {
  const mockAnim = {
    cancel: vi.fn(),
    onfinish: null as (() => void) | null,
    oncancel: null as (() => void) | null,
  };
  const spy = vi.fn().mockReturnValue(mockAnim);
  Object.defineProperty(el, 'animate', {
    configurable: true,
    writable: true,
    value: spy,
  });
  return { spy, mockAnim };
}

describe('LayoutAnimator & Transition Sequencing', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetLayoutAnimatorForTesting();
    layoutService.resetForTesting();
  });

  it('computes FLIP translate3d keyframes without scale distortion across reposition changes and restores inline styles', async () => {
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.flipId = 'vp-1';
    pane.getBoundingClientRect = () => makeRect(100, 50, 800, 600);
    root.appendChild(stage);
    root.appendChild(pane);
    document.body.appendChild(root);

    const snapshot = captureLayoutSnapshot('layout');
    await Promise.resolve();

    pane.getBoundingClientRect = () => makeRect(500, 50, 400, 600);
    const { spy, mockAnim } = attachMockAnimate(pane);

    playLayoutAnimation(root, stage, snapshot, 'vp-1');

    expect(spy).toHaveBeenCalledTimes(1);
    const [keyframes, options] = spy.mock.calls[0];
    expect(keyframes).toEqual([
      { transform: 'translate3d(-400px, 0px, 0)' },
      { transform: 'translate3d(0, 0, 0)' },
    ]);
    expect(options).toEqual({
      duration: 220,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    expect(pane.style.zIndex).toBe('18');
    expect(pane.style.transformOrigin).toBe('0 0');

    mockAnim.onfinish?.();
    expect(pane.style.zIndex).toBe('');
    expect(pane.style.transformOrigin).toBe('');
  });

  it('keeps existing terminal group unscaled and stationary during anchored vertical split open/close while animating new bottom pane', async () => {
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const termGroup = document.createElement('div');
    termGroup.dataset.groupContainer = 'grp-term';
    termGroup.dataset.flipId = 'vp-term';
    termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 600);
    stage.appendChild(termGroup);
    root.appendChild(stage);
    document.body.appendChild(root);

    // 1. Opening bottom SFTP shrinks termGroup height from 600 -> 408 with dx=0, dy=0
    const openSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();

    termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 408);
    const { spy: termSpy } = attachMockAnimate(termGroup);

    const sftpGroup = document.createElement('div');
    sftpGroup.dataset.groupContainer = 'grp-sftp';
    sftpGroup.dataset.flipId = 'vp-sftp';
    sftpGroup.getBoundingClientRect = () => makeRect(0, 458, 800, 192);
    stage.appendChild(sftpGroup);
    const { spy: sftpSpy } = attachMockAnimate(sftpGroup);

    playLayoutAnimation(root, stage, openSnap, 'vp-sftp');

    expect(termSpy).not.toHaveBeenCalled();
    expect(sftpSpy).toHaveBeenCalledTimes(1);

    // 2. Closing bottom SFTP expands termGroup height from 408 -> 600 with dx=0, dy=0
    const closeSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();

    sftpGroup.remove();
    termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 600);

    playLayoutAnimation(root, stage, closeSnap, 'vp-term');

    expect(termSpy).not.toHaveBeenCalled();
  });

  it('animates newly revealed split panes cleanly without full opacity hide', async () => {
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const existingGroup = document.createElement('div');
    existingGroup.dataset.groupContainer = 'grp-main';
    existingGroup.dataset.flipId = 'vp-old';
    existingGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 600);
    const tab = document.createElement('div');
    tab.dataset.flipTabId = 'vp-new';
    tab.getBoundingClientRect = () => makeRect(100, 20, 80, 24);
    existingGroup.appendChild(tab);
    stage.appendChild(existingGroup);
    root.appendChild(stage);
    document.body.appendChild(root);

    const snapshot = captureLayoutSnapshot('layout');
    await Promise.resolve();

    const newPane = document.createElement('div');
    newPane.dataset.groupContainer = 'grp-new';
    newPane.dataset.flipId = 'vp-new';
    newPane.getBoundingClientRect = () => makeRect(400, 100, 400, 300);
    stage.appendChild(newPane);
    const { spy, mockAnim } = attachMockAnimate(newPane);

    playLayoutAnimation(root, stage, snapshot, 'vp-new');

    expect(spy).toHaveBeenCalledTimes(1);
    const [keyframes, options] = spy.mock.calls[0];
    // tabCenter=(140,32), paneCenter=(600,250) -> dx=clamp(-460*0.12,-36,36)=-36, dy=-26.16
    const firstFrame = (keyframes as Keyframe[])[0];
    expect(firstFrame.opacity).toBe(0.45);
    expect(firstFrame.transform).toContain('translate3d(-36px');
    expect(firstFrame.transform).toContain('scale(0.96)');
    expect((keyframes as Keyframe[])[1]).toEqual({
      opacity: 1,
      transform: 'translate3d(0, 0, 0) scale(1)',
    });
    expect(options).toEqual({
      duration: 200,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });

    mockAnim.onfinish?.();
    expect(newPane.style.transformOrigin).toBe('');
  });

  it('keeps stationary DockGroupView steady on Tab open/close while animating tab pills and subtle content fade', async () => {
    // 1. Opening a second tab in Tab mode (+ Shell)
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const groupEl = document.createElement('div');
    groupEl.dataset.groupContainer = 'grp-1';
    groupEl.dataset.flipId = 'vp-1';
    groupEl.getBoundingClientRect = () => makeRect(100, 50, 800, 600);

    const tab1 = document.createElement('div');
    tab1.dataset.flipTabId = 'vp-1';
    tab1.getBoundingClientRect = () => makeRect(108, 54, 110, 24);
    const contentHost = document.createElement('div');
    const innerVp2 = document.createElement('div');
    innerVp2.dataset.viewportId = 'vp-2';

    groupEl.appendChild(tab1);
    groupEl.appendChild(contentHost);
    stage.appendChild(groupEl);
    root.appendChild(stage);
    document.body.appendChild(root);

    const openSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();

    // Switch active viewport in the stationary group to new vp-2 and add new tab pill
    groupEl.dataset.flipId = 'vp-2';
    contentHost.appendChild(innerVp2);
    const tab2 = document.createElement('div');
    tab2.dataset.flipTabId = 'vp-2';
    tab2.getBoundingClientRect = () => makeRect(222, 54, 110, 24);
    groupEl.appendChild(tab2);

    const { spy: groupSpy } = attachMockAnimate(groupEl);
    const { spy: innerSpy } = attachMockAnimate(innerVp2);
    const { spy: tab2Spy } = attachMockAnimate(tab2);

    playLayoutAnimation(root, stage, openSnap, 'vp-2');

    expect(groupSpy).not.toHaveBeenCalled();
    expect(innerSpy).toHaveBeenCalledWith(
      [{ opacity: 0.7 }, { opacity: 1 }],
      { duration: 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    expect(tab2Spy).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: 'translate3d(-10px, 0, 0) scale(0.94)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      { duration: 170, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );

    // 2. Closing vp-2 in Tab mode (falling back to vp-1 whose tab pill sits top-left, while tab-3 slides left)
    groupSpy.mockClear();
    const tab3 = document.createElement('div');
    tab3.dataset.flipTabId = 'vp-3';
    tab3.getBoundingClientRect = () => makeRect(342, 54, 110, 24);
    groupEl.appendChild(tab3);

    const closeSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();

    // Simulate close of vp-2: group switches back to vp-1, tab-2 removed, tab-3 shifts -120px left
    groupEl.dataset.flipId = 'vp-1';
    tab2.remove();
    tab3.getBoundingClientRect = () => makeRect(222, 54, 110, 24);
    const innerVp1 = document.createElement('div');
    innerVp1.dataset.viewportId = 'vp-1';
    contentHost.appendChild(innerVp1);

    const { spy: inner1Spy } = attachMockAnimate(innerVp1);
    const { spy: tab3Spy } = attachMockAnimate(tab3);

    playLayoutAnimation(root, stage, closeSnap, 'vp-1');

    expect(groupSpy).not.toHaveBeenCalled();
    expect(inner1Spy).toHaveBeenCalledWith(
      [{ opacity: 0.7 }, { opacity: 1 }],
      { duration: 120, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    expect(tab3Spy).toHaveBeenCalledWith(
      [
        { transform: 'translate3d(120px, 0, 0)' },
        { transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  });

  it('plays directional workspace transition on stage and reveals intra-group tabs smoothly', async () => {
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.viewportId = 'vp-a';
    stage.appendChild(pane);
    root.appendChild(stage);
    document.body.appendChild(root);

    const { spy: stageSpy } = attachMockAnimate(stage);
    const forwardSnap = captureLayoutSnapshot('workspace', 1);
    await Promise.resolve();
    playLayoutAnimation(root, stage, forwardSnap, 'vp-a');

    expect(stageSpy).toHaveBeenCalledWith(
      [
        { opacity: 0.35, transform: 'translate3d(20px, 0, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 210, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );

    const { spy: revealSpy } = attachMockAnimate(pane);
    animateViewportReveal(stage, 'vp-a');
    expect(revealSpy).toHaveBeenCalledWith(
      [
        { opacity: 0.35, transform: 'translate3d(0, 4px, 0)' },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  });

  it('increments layoutTransitionSeq only for discrete transitions and never for continuous drag/resize', async () => {
    const t1 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Term 1',
      preferredDock: 'center',
    });
    await Promise.resolve();
    const t2 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Term 2',
      preferredDock: 'center',
    });
    await Promise.resolve();

    const seqBeforeArrange = useLayoutStore.getState().layoutTransitionSeq;
    layoutService.arrangeWorkspaceShells('vsp');
    await Promise.resolve();
    const seqAfterArrange = useLayoutStore.getState().layoutTransitionSeq;
    expect(seqAfterArrange).toBeGreaterThan(seqBeforeArrange);

    // Continuous pointer operations must NOT increment layoutTransitionSeq
    const root = useLayoutStore.getState().dockRoot;
    if (root?.type === 'split') {
      layoutService.setSplitRatio(root.id, 0.4);
    }
    layoutService.setDrawerWidth('left', 310);
    expect(useLayoutStore.getState().layoutTransitionSeq).toBe(seqAfterArrange);

    layoutService.floatViewport(t1.id, { x: 40, y: 40, width: 400, height: 300 });
    await Promise.resolve();
    const seqAfterFloat = useLayoutStore.getState().layoutTransitionSeq;
    expect(seqAfterFloat).toBeGreaterThan(seqAfterArrange);

    layoutService.moveFloating(t1.id, 90, 90);
    layoutService.resizeFloating(t1.id, { x: 90, y: 90, width: 460, height: 340 });
    expect(useLayoutStore.getState().layoutTransitionSeq).toBe(seqAfterFloat);

    // Discrete maximize & workspace switch must increment layoutTransitionSeq
    layoutService.toggleMaximize(t2.id);
    await Promise.resolve();
    const seqAfterMax = useLayoutStore.getState().layoutTransitionSeq;
    expect(seqAfterMax).toBeGreaterThan(seqAfterFloat);

    const ws1 = useLayoutStore.getState().activeWorkspaceId;
    layoutService.createWorkspace('Workspace 2');
    await Promise.resolve();
    const seqAfterWsCreate = useLayoutStore.getState().layoutTransitionSeq;
    expect(seqAfterWsCreate).toBeGreaterThan(seqAfterMax);

    layoutService.selectWorkspace(ws1);
    await Promise.resolve();
    expect(useLayoutStore.getState().layoutTransitionSeq).toBeGreaterThan(seqAfterWsCreate);
  });

  it('slides Left/Right drawers out from their respective edges and keeps already-open drawers steady', async () => {
    const root = document.createElement('div');
    const stage = document.createElement('div');
    const centerPane = document.createElement('div');
    centerPane.dataset.groupContainer = 'grp-1';
    centerPane.dataset.flipId = 'vp-term';
    centerPane.getBoundingClientRect = () => makeRect(44, 50, 900, 600);
    stage.appendChild(centerPane);
    root.appendChild(stage);
    document.body.appendChild(root);

    // 1. Open Left Drawer from collapsed state -> slides from -100% -> 0 with temporary overflow clip
    const openLeftSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();

    const leftSlot = document.createElement('div');
    leftSlot.dataset.drawerSlot = 'left';
    const leftPanel = document.createElement('div');
    leftPanel.dataset.drawerSide = 'left';
    leftPanel.dataset.drawerViewportId = 'vp-hosts';
    leftPanel.getBoundingClientRect = () => makeRect(44, 50, 272, 600);
    leftSlot.appendChild(leftPanel);
    root.insertBefore(leftSlot, stage);
    centerPane.getBoundingClientRect = () => makeRect(316, 50, 628, 600);

    const { spy: leftSpy, mockAnim: leftAnim } = attachMockAnimate(leftPanel);
    attachMockAnimate(centerPane);

    playLayoutAnimation(root, stage, openLeftSnap, 'vp-hosts');

    expect(leftSpy).toHaveBeenCalledWith(
      [{ transform: 'translate3d(-100%, 0, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    expect(leftSlot.style.overflow).toBe('hidden');
    leftAnim.onfinish?.();
    expect(leftSlot.style.overflow).toBe('');

    // 2. Open Right Drawer while Left Drawer is already open -> Right slides from +100% -> 0, Left stays still
    leftSpy.mockClear();
    const openRightSnap = captureLayoutSnapshot('layout');
    await Promise.resolve();
    expect(openRightSnap.drawerRects.has('left')).toBe(true);

    const rightSlot = document.createElement('div');
    rightSlot.dataset.drawerSlot = 'right';
    const rightPanel = document.createElement('div');
    rightPanel.dataset.drawerSide = 'right';
    rightPanel.dataset.drawerViewportId = 'vp-monitor';
    rightPanel.getBoundingClientRect = () => makeRect(900, 50, 288, 600);
    rightSlot.appendChild(rightPanel);
    root.appendChild(rightSlot);

    const { spy: rightSpy, mockAnim: rightAnim } = attachMockAnimate(rightPanel);

    playLayoutAnimation(root, stage, openRightSnap, 'vp-monitor');

    expect(leftSpy).not.toHaveBeenCalled();
    expect(rightSpy).toHaveBeenCalledWith(
      [{ transform: 'translate3d(100%, 0, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
    expect(rightSlot.style.overflow).toBe('hidden');
    rightAnim.onfinish?.();
    expect(rightSlot.style.overflow).toBe('');
  });

  it('slides bottom viewport up on open and down via clipped exit ghost on hide without animating terminal', async () => {
    const calls: { el: HTMLElement; keyframes: unknown; options: unknown; anim: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null } }[] = [];
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: function mockAnimate(this: HTMLElement, keyframes: unknown, options: unknown) {
        const anim = {
          cancel: vi.fn(),
          onfinish: null as (() => void) | null,
          oncancel: null as (() => void) | null,
        };
        calls.push({ el: this, keyframes, options, anim });
        return anim;
      },
    });

    try {
      const root = document.createElement('div');
      const stage = document.createElement('div');
      stage.getBoundingClientRect = () => makeRect(0, 50, 800, 600);

      const termSlot = document.createElement('div');
      termSlot.dataset.groupSlot = 'grp-term';
      termSlot.style.height = '100%';
      termSlot.getBoundingClientRect = () => makeRect(0, 50, 800, 600);
      const termGroup = document.createElement('div');
      termGroup.dataset.groupContainer = 'grp-term';
      termGroup.dataset.flipId = 'vp-term';
      termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 600);
      termSlot.appendChild(termGroup);
      stage.appendChild(termSlot);
      root.appendChild(stage);
      document.body.appendChild(root);

      // 1. Open bottom panel -> slides UP translate3d(0, 100%, 0) -> translate3d(0, 0, 0), pins top slot, slides separator together
      const openSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();

      termSlot.style.height = '68%';
      termSlot.getBoundingClientRect = () => makeRect(0, 50, 800, 408);
      termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 408);

      const bottomSlot = document.createElement('div');
      bottomSlot.dataset.groupSlot = 'grp-sftp';
      bottomSlot.dataset.dockEdge = 'bottom';
      bottomSlot.getBoundingClientRect = () => makeRect(0, 458, 800, 192);
      const bottomGroup = document.createElement('div');
      bottomGroup.dataset.groupContainer = 'grp-sftp';
      bottomGroup.dataset.flipId = 'vp-sftp';
      bottomGroup.getBoundingClientRect = () => makeRect(0, 458, 800, 192);
      bottomSlot.appendChild(bottomGroup);
      stage.appendChild(bottomSlot);

      const bottomSep = document.createElement('div');
      bottomSep.dataset.splitSeparatorEdge = 'bottom';
      stage.appendChild(bottomSep);

      playLayoutAnimation(root, stage, openSnap, 'vp-sftp');

      expect(calls.some((c) => c.el === termGroup)).toBe(false);
      expect(termSlot.style.height).toBe('600px');
      expect(bottomSlot.style.zIndex).toBe('15');
      expect(bottomSep.style.zIndex).toBe('16');

      const sepCall = calls.find((c) => c.el === bottomSep);
      expect(sepCall).toBeTruthy();
      expect(sepCall!.keyframes).toEqual([
        { transform: 'translate3d(0, 192px, 0)' },
        { transform: 'translate3d(0, 0, 0)' },
      ]);
      expect(sepCall!.options).toEqual({
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });

      const enterCall = calls.find((c) => c.el === bottomGroup);
      expect(enterCall).toBeTruthy();
      expect(enterCall!.keyframes).toEqual([
        { transform: 'translate3d(0, 100%, 0)' },
        { transform: 'translate3d(0, 0, 0)' },
      ]);
      expect(enterCall!.options).toEqual({
        duration: 220,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      });
      expect(bottomSlot.style.overflow).toBe('hidden');

      sepCall!.anim.onfinish?.();
      enterCall!.anim.onfinish?.();
      expect(bottomSlot.style.overflow).toBe('');
      expect(bottomSlot.style.zIndex).toBe('');
      expect(bottomSep.style.zIndex).toBe('');
      expect(termSlot.style.height).toBe('68%');

      // 2. Hide bottom panel -> spawns [data-exit-ghost="dock-bottom"] sliding DOWN translate3d(0, 0, 0) -> translate3d(0, 100%, 0)
      calls.length = 0;
      const closeSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();
      expect(closeSnap.bottomExitSnapshots.has('grp-sftp')).toBe(true);

      bottomSlot.remove();
      bottomSep.remove();
      termSlot.style.height = '100%';
      termSlot.getBoundingClientRect = () => makeRect(0, 50, 800, 600);
      termGroup.getBoundingClientRect = () => makeRect(0, 50, 800, 600);

      playLayoutAnimation(root, stage, closeSnap, 'vp-term');

      expect(calls.some((c) => c.el === termGroup)).toBe(false);
      const ghostWrapper = stage.querySelector<HTMLElement>('[data-exit-ghost="dock-bottom"]');
      expect(ghostWrapper).toBeTruthy();
      expect(ghostWrapper!.style.pointerEvents).toBe('none');
      expect(ghostWrapper!.style.overflow).toBe('hidden');
      expect(ghostWrapper!.style.top).toBe('408px');
      expect(ghostWrapper!.style.height).toBe('192px');
      expect(ghostWrapper!.firstElementChild?.getAttribute('data-flip-id')).toBeNull();

      const exitCall = calls.find((c) => c.el === ghostWrapper!.firstElementChild);
      expect(exitCall).toBeTruthy();
      expect(exitCall!.keyframes).toEqual([
        { transform: 'translate3d(0, 0, 0)' },
        { transform: 'translate3d(0, 100%, 0)' },
      ]);

      exitCall!.anim.onfinish?.();
      expect(stage.querySelector('[data-exit-ghost="dock-bottom"]')).toBeNull();
    } finally {
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      } else {
        delete (HTMLElement.prototype as { animate?: unknown }).animate;
      }
    }
  });

  it('slides Left/Right drawers out smoothly on collapse, cancels cleanly on rapid reopen, and skips ghost when moved to canvas', async () => {
    const calls: { el: HTMLElement; keyframes: unknown; options: unknown; anim: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null } }[] = [];
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
    Object.defineProperty(HTMLElement.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: function mockAnimate(this: HTMLElement, keyframes: unknown, options: unknown) {
        const anim = {
          cancel: vi.fn(),
          onfinish: null as (() => void) | null,
          oncancel: null as (() => void) | null,
        };
        calls.push({ el: this, keyframes, options, anim });
        return anim;
      },
    });

    try {
      const root = document.createElement('div');
      root.getBoundingClientRect = () => makeRect(0, 50, 1200, 600);
      const stage = document.createElement('div');
      const centerPane = document.createElement('div');
      centerPane.dataset.groupContainer = 'grp-1';
      centerPane.dataset.flipId = 'vp-term';
      centerPane.getBoundingClientRect = () => makeRect(316, 50, 552, 600);
      stage.appendChild(centerPane);

      const leftSlot = document.createElement('div');
      leftSlot.dataset.drawerSlot = 'left';
      leftSlot.getBoundingClientRect = () => makeRect(44, 50, 272, 600);
      const leftPanel = document.createElement('div');
      leftPanel.dataset.drawerSide = 'left';
      leftPanel.dataset.drawerViewportId = 'vp-hosts';
      leftPanel.getBoundingClientRect = () => makeRect(44, 50, 272, 600);
      leftSlot.appendChild(leftPanel);

      const rightSlot = document.createElement('div');
      rightSlot.dataset.drawerSlot = 'right';
      rightSlot.getBoundingClientRect = () => makeRect(868, 50, 288, 600);
      const rightPanel = document.createElement('div');
      rightPanel.dataset.drawerSide = 'right';
      rightPanel.dataset.drawerViewportId = 'vp-monitor';
      rightPanel.getBoundingClientRect = () => makeRect(868, 50, 288, 600);
      rightSlot.appendChild(rightPanel);

      root.appendChild(leftSlot);
      root.appendChild(stage);
      root.appendChild(rightSlot);
      document.body.appendChild(root);

      // 1. Collapse Left Drawer -> [data-exit-ghost="drawer-left"] slides out to -100%
      const collapseLeftSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();
      leftSlot.remove();
      centerPane.getBoundingClientRect = () => makeRect(44, 50, 824, 600);

      playLayoutAnimation(root, stage, collapseLeftSnap, 'vp-term');

      const leftGhost = root.querySelector<HTMLElement>('[data-exit-ghost="drawer-left"]');
      expect(leftGhost).toBeTruthy();
      expect(leftGhost!.style.left).toBe('44px');
      expect(leftGhost!.style.width).toBe('272px');
      const leftExitCall = calls.find((c) => c.el === leftGhost!.firstElementChild);
      expect(leftExitCall).toBeTruthy();
      expect(leftExitCall!.keyframes).toEqual([
        { transform: 'translate3d(0, 0, 0)' },
        { transform: 'translate3d(-100%, 0, 0)' },
      ]);
      leftExitCall!.anim.onfinish?.();
      expect(root.querySelector('[data-exit-ghost="drawer-left"]')).toBeNull();

      // 2. Collapse Right Drawer -> slides out to +100%; rapid reopen cancels exit ghost & slides back in from +100% -> 0
      calls.length = 0;
      const collapseRightSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();
      rightSlot.remove();
      centerPane.getBoundingClientRect = () => makeRect(44, 50, 1112, 600);

      playLayoutAnimation(root, stage, collapseRightSnap, 'vp-term');

      const rightGhost = root.querySelector<HTMLElement>('[data-exit-ghost="drawer-right"]');
      expect(rightGhost).toBeTruthy();
      const rightExitCall = calls.find((c) => c.el === rightGhost!.firstElementChild);
      expect(rightExitCall).toBeTruthy();
      expect(rightExitCall!.keyframes).toEqual([
        { transform: 'translate3d(0, 0, 0)' },
        { transform: 'translate3d(100%, 0, 0)' },
      ]);

      // Rapid reopen before rightExitCall finishes
      const reopenRightSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();
      root.appendChild(rightSlot);
      centerPane.getBoundingClientRect = () => makeRect(44, 50, 824, 600);

      playLayoutAnimation(root, stage, reopenRightSnap, 'vp-monitor');

      expect(rightExitCall!.anim.cancel).toHaveBeenCalledTimes(1);
      expect(root.querySelector('[data-exit-ghost="drawer-right"]')).toBeNull();
      expect(calls.find((c) => c.el === rightPanel)?.keyframes).toEqual([
        { transform: 'translate3d(100%, 0, 0)' },
        { transform: 'translate3d(0, 0, 0)' },
      ]);

      // 3. Moving Right Drawer's viewport to center dock does NOT create a drawer exit ghost
      calls.length = 0;
      const moveSnap = captureLayoutSnapshot('layout');
      await Promise.resolve();
      rightSlot.remove();
      const movedCenter = document.createElement('div');
      movedCenter.dataset.groupContainer = 'grp-moved';
      movedCenter.dataset.flipId = 'vp-monitor';
      movedCenter.getBoundingClientRect = () => makeRect(600, 50, 400, 600);
      stage.appendChild(movedCenter);

      playLayoutAnimation(root, stage, moveSnap, 'vp-monitor');
      expect(root.querySelector('[data-exit-ghost="drawer-right"]')).toBeNull();
    } finally {
      if (originalAnimate) {
        Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
      } else {
        delete (HTMLElement.prototype as { animate?: unknown }).animate;
      }
    }
  });
});
