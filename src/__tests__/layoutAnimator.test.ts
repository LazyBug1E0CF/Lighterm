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

  it('computes FLIP translate3d + scale keyframes across geometry changes and restores inline styles', async () => {
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
      { transform: 'translate3d(-400px, 0px, 0) scale(2, 1)' },
      { transform: 'translate3d(0, 0, 0) scale(1, 1)' },
    ]);
    expect(options).toEqual({
      duration: 260,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
    expect(pane.style.zIndex).toBe('18');
    expect(pane.style.transformOrigin).toBe('0 0');

    mockAnim.onfinish?.();
    expect(pane.style.zIndex).toBe('');
    expect(pane.style.transformOrigin).toBe('');
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
});
