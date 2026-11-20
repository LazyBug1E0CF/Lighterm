import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectGroups,
  dockViewportAtEdge,
  dockViewportInGroup,
  findGroupContainingViewport,
  pruneUnavailableViewports,
  removeViewportFromTree,
  updateDockSplitRatio,
} from '../layout/dockTree';
import { layoutService, useLayoutStore } from '../layout/layoutStore';

describe('Universal DockTree & LayoutService', () => {
  beforeEach(() => {
    layoutService.resetForTesting();
  });

  it('supports edge docking, 5-zone group splitting/tab merging, auto-collapse, ratio clamping, and pruning', () => {
    let root = dockViewportAtEdge(null, 'vp-1', 'left');
    expect(root.type).toBe('group');
    const centerGroupId = collectGroups(root)[0].id;

    // Merge vp-2 as tab in center group
    root = dockViewportInGroup(root, 'vp-2', centerGroupId, 'center');
    expect(collectGroups(root)).toHaveLength(1);
    expect(collectGroups(root)[0].viewportIds).toEqual(['vp-1', 'vp-2']);
    expect(collectGroups(root)[0].activeViewportId).toBe('vp-2');

    // Split vp-2 right into its own branch
    root = dockViewportInGroup(root, 'vp-2', centerGroupId, 'right', 0.6);
    expect(root.type).toBe('split');
    expect(collectGroups(root)).toHaveLength(2);

    // Dock vp-3 to outer bottom edge and vp-4 to outer top edge
    root = dockViewportAtEdge(root, 'vp-3', 'bottom', 0.7);
    root = dockViewportAtEdge(root, 'vp-4', 'top', 0.2);
    expect(collectGroups(root)).toHaveLength(4);

    // Clamp split ratio within [0.1, 0.9]
    if (root.type === 'split') {
      root = updateDockSplitRatio(root, root.id, 0.99)!;
      expect(root.type === 'split' && root.ratio).toBe(0.9);
      root = updateDockSplitRatio(root, root.id, 0.01)!;
      expect(root.type === 'split' && root.ratio).toBe(0.1);
    }

    // Prune unavailable viewports (simulating disabled plugin) without losing rest of tree
    const pruned = pruneUnavailableViewports(root, (id) => id !== 'vp-3' && id !== 'vp-4');
    expect(collectGroups(pruned)).toHaveLength(2);
    expect(findGroupContainingViewport(pruned, 'vp-3')).toBeNull();

    // Removing vp-2 collapses its split and leaves only vp-1
    const collapsed = removeViewportFromTree(pruned, 'vp-2');
    expect(collapsed?.type).toBe('group');
    expect(collectGroups(collapsed)[0].viewportIds).toEqual(['vp-1']);
  });

  it('floats, moves, clamps resize, and re-docks viewports cleanly', () => {
    layoutService.setWorkspaceBounds(1000, 700);
    const vp1 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Term 1',
      preferredDock: 'center',
    });

    layoutService.floatViewport(vp1.id, { x: 100, y: 80, width: 480, height: 320 });
    expect(useLayoutStore.getState().dockRoot).toBeNull();
    expect(useLayoutStore.getState().floating).toHaveLength(1);

    // Resize below minimum clamps to 280x180
    layoutService.resizeFloating(vp1.id, { x: 50, y: 40, width: 120, height: 90 });
    const floated = useLayoutStore.getState().floating[0];
    expect(floated.width).toBe(280);
    expect(floated.height).toBe(180);

    // Dock back to bottom edge removes from floating and puts in dockRoot
    layoutService.dockToEdge(vp1.id, 'bottom');
    expect(useLayoutStore.getState().floating).toHaveLength(0);
    expect(findGroupContainingViewport(useLayoutStore.getState().dockRoot, vp1.id)).not.toBeNull();
  });
});
