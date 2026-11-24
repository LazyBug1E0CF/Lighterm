import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPresetDockTree,
  collectGroups,
  computeFlatDockLayout,
  dockViewportAtEdge,
  dockViewportInGroup,
  findGroupContainingViewport,
  pruneUnavailableViewports,
  removeViewportFromTree,
  updateDockSplitRatio,
} from '../layout/dockTree';
import { layoutService, readDrawerPrefs, useLayoutStore } from '../layout/layoutStore';

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

  it('supports collapsible/resizable left and right drawers and moves viewports uniquely across drawers, floating, and dockRoot', () => {
    const vpA = layoutService.openViewport({
      typeId: 'hosts.manager',
      pluginId: 'lighterm.hosts',
      title: 'SSH Hosts',
      preferredDock: 'left-drawer',
    });
    const vpB = layoutService.openViewport({
      typeId: 'snippets.panel',
      pluginId: 'lighterm.snippets',
      title: 'Snippets',
      preferredDock: 'left-drawer',
      activateDrawer: false,
    });

    expect(useLayoutStore.getState().leftDrawer.viewportIds).toEqual([vpA.id, vpB.id]);
    expect(useLayoutStore.getState().leftDrawer.activeViewportId).toBe(vpA.id);
    expect(useLayoutStore.getState().leftDrawer.open).toBe(true);

    // Clicking active rail item collapses drawer; clicking again re-expands
    layoutService.selectDrawerViewport('left', vpA.id);
    expect(useLayoutStore.getState().leftDrawer.open).toBe(false);
    layoutService.selectDrawerViewport('left', vpB.id);
    expect(useLayoutStore.getState().leftDrawer.open).toBe(true);
    expect(useLayoutStore.getState().leftDrawer.activeViewportId).toBe(vpB.id);

    // Clamp drawer width within [200, 600]
    layoutService.setDrawerWidth('left', 100);
    expect(useLayoutStore.getState().leftDrawer.width).toBe(200);
    layoutService.setDrawerWidth('right', 900);
    expect(useLayoutStore.getState().rightDrawer.width).toBe(600);

    // Move vpB to right drawer -> detached from leftDrawer cleanly
    layoutService.dockToDrawer(vpB.id, 'right');
    expect(useLayoutStore.getState().leftDrawer.viewportIds).toEqual([vpA.id]);
    expect(useLayoutStore.getState().rightDrawer.viewportIds).toEqual([vpB.id]);
    expect(layoutService.getViewportLocation(vpB.id)).toBe('right-drawer');

    // Float vpB -> detached from rightDrawer (which collapses since empty)
    layoutService.floatViewport(vpB.id);
    expect(useLayoutStore.getState().rightDrawer.viewportIds).toEqual([]);
    expect(useLayoutStore.getState().rightDrawer.open).toBe(false);
    expect(layoutService.getViewportLocation(vpB.id)).toBe('floating');

    // Dock vpB back to center -> detached from floating
    layoutService.dockToEdge(vpB.id, 'bottom');
    expect(useLayoutStore.getState().floating).toHaveLength(0);
    expect(layoutService.getViewportLocation(vpB.id)).toBe('docked');
  });

  it('builds balanced tab, vsp, hsp, and grid preset dock trees', () => {
    // Tab preset merges all viewports into one group and respects preferredActiveId
    const tabRoot = buildPresetDockTree(['t1', 't2', 't3'], 'tab', 't2');
    expect(tabRoot?.type).toBe('group');
    expect(collectGroups(tabRoot)[0].viewportIds).toEqual(['t1', 't2', 't3']);
    expect(collectGroups(tabRoot)[0].activeViewportId).toBe('t2');

    // VSP preset arranges 3 panes side by side with equal column ratios (1/3, then 1/2)
    const vspRoot = buildPresetDockTree(['t1', 't2', 't3'], 'vsp');
    expect(vspRoot?.type).toBe('split');
    if (vspRoot?.type === 'split') {
      expect(vspRoot.direction).toBe('horizontal');
      expect(vspRoot.ratio).toBeCloseTo(1 / 3, 4);
      expect(vspRoot.second.type).toBe('split');
      if (vspRoot.second.type === 'split') {
        expect(vspRoot.second.direction).toBe('horizontal');
        expect(vspRoot.second.ratio).toBeCloseTo(0.5, 4);
      }
    }
    expect(collectGroups(vspRoot).map((g) => g.viewportIds[0])).toEqual(['t1', 't2', 't3']);

    // HSP preset arranges 3 panes top to bottom with equal row ratios
    const hspRoot = buildPresetDockTree(['t1', 't2', 't3'], 'hsp');
    expect(hspRoot?.type).toBe('split');
    if (hspRoot?.type === 'split') {
      expect(hspRoot.direction).toBe('vertical');
      expect(hspRoot.ratio).toBeCloseTo(1 / 3, 4);
      expect(hspRoot.second.type).toBe('split');
      if (hspRoot.second.type === 'split') {
        expect(hspRoot.second.direction).toBe('vertical');
        expect(hspRoot.second.ratio).toBeCloseTo(0.5, 4);
      }
    }

    // Grid preset builds 2x2 for 4 panes and 2 rows x 3 cols for 5 panes
    const grid2x2 = buildPresetDockTree(['t1', 't2', 't3', 't4'], 'grid');
    expect(grid2x2?.type).toBe('split');
    if (grid2x2?.type === 'split') {
      expect(grid2x2.direction).toBe('vertical');
      expect(grid2x2.ratio).toBeCloseTo(0.5, 4);
      expect(grid2x2.first.type).toBe('split');
      expect(grid2x2.second.type).toBe('split');
      if (grid2x2.first.type === 'split') {
        expect(grid2x2.first.direction).toBe('horizontal');
      }
    }
    expect(collectGroups(grid2x2)).toHaveLength(4);

    const grid2x3 = buildPresetDockTree(['t1', 't2', 't3', 't4', 't5'], 'grid');
    expect(grid2x3?.type).toBe('split');
    if (grid2x3?.type === 'split') {
      expect(grid2x3.direction).toBe('vertical');
      expect(collectGroups(grid2x3.first)).toHaveLength(3);
      expect(collectGroups(grid2x3.second)).toHaveLength(2);
    }
  });

  it('manages multi-workspace lifecycle, scopes new viewports, and preserves non-shell panels during quick layout arrange', () => {
    const t1 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Terminal 1',
      preferredDock: 'center',
    });
    const t2 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Terminal 2',
      preferredDock: 'center',
    });
    const sftp = layoutService.openViewport({
      typeId: 'sftp.browser',
      pluginId: 'lighterm.sftp',
      title: 'SFTP Browser',
      preferredDock: 'bottom',
    });

    const ws1Id = useLayoutStore.getState().activeWorkspaceId;
    expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(2);

    // Arrange Workspace 1 shells into VSP -> 2 terminal groups + preserved SFTP group
    layoutService.arrangeWorkspaceShells('vsp');
    expect(useLayoutStore.getState().activeLayoutPreset).toBe('vsp');
    const groupsAfterVsp = collectGroups(useLayoutStore.getState().dockRoot);
    expect(groupsAfterVsp).toHaveLength(3);
    expect(findGroupContainingViewport(useLayoutStore.getState().dockRoot, sftp.id)).not.toBeNull();

    // Opening another shell while activeLayoutPreset === 'vsp' automatically includes it in VSP
    const t3 = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Terminal 3',
      preferredDock: 'center',
    });
    expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(3);
    expect(collectGroups(useLayoutStore.getState().dockRoot)).toHaveLength(4);

    // Create Workspace 2 -> becomes active with empty center, leaving Workspace 1 isolated
    const ws2 = layoutService.createWorkspace();
    expect(ws2.name).toBe('Workspace 2');
    expect(useLayoutStore.getState().activeWorkspaceId).toBe(ws2.id);
    expect(useLayoutStore.getState().dockRoot).toBeNull();

    layoutService.renameWorkspace(ws2.id, 'Prod Cluster');
    layoutService.renameWorkspace(ws2.id, '   ');
    expect(useLayoutStore.getState().workspaces.find((w) => w.id === ws2.id)?.name).toBe(
      'Prod Cluster',
    );

    const ws2Term = layoutService.openViewport({
      typeId: 'terminal.viewport',
      pluginId: 'lighterm.terminal',
      title: 'Terminal 4',
      preferredDock: 'center',
    });
    expect(layoutService.getWorkspaceViewportIds(ws2.id)).toEqual([ws2Term.id]);
    expect(layoutService.getWorkspaceViewportIds(ws1Id)).toEqual([t1.id, t2.id, t3.id, sftp.id]);

    // Switching back to Workspace 1 restores VSP preset and 4 viewports
    layoutService.selectWorkspace(ws1Id);
    expect(useLayoutStore.getState().activeLayoutPreset).toBe('vsp');
    expect(layoutService.findWorkspaceViewportsByType('terminal.viewport')).toHaveLength(3);

    // Closing Workspace 2 removes ws2Term from store without touching Workspace 1
    layoutService.closeWorkspace(ws2.id);
    expect(useLayoutStore.getState().workspaces).toHaveLength(1);
    expect(useLayoutStore.getState().viewports[ws2Term.id]).toBeUndefined();
    expect(useLayoutStore.getState().viewports[t1.id]).toBeDefined();
  });

  it('supports drawer auto-collapse toggles, blur auto-collapse, and localStorage persistence', () => {
    window.localStorage.clear();
    layoutService.resetForTesting();

    layoutService.openViewport({
      typeId: 'hosts.manager',
      pluginId: 'lighterm.hosts',
      title: 'SSH Hosts',
      preferredDock: 'left-drawer',
    });
    layoutService.openViewport({
      typeId: 'monitor.panel',
      pluginId: 'lighterm.monitor',
      title: 'System Status',
      preferredDock: 'right-drawer',
    });

    expect(useLayoutStore.getState().leftDrawer.autoCollapse).toBe(false);
    expect(useLayoutStore.getState().rightDrawer.autoCollapse).toBe(false);

    // autoCollapseDrawer is a no-op when autoCollapse is off
    layoutService.autoCollapseDrawer('left');
    expect(useLayoutStore.getState().leftDrawer.open).toBe(true);

    // Enable auto-collapse on both drawers -> persists to localStorage and keeps drawers open
    layoutService.setDrawerAutoCollapse('left', true);
    layoutService.toggleDrawerAutoCollapse('right');
    expect(useLayoutStore.getState().leftDrawer.autoCollapse).toBe(true);
    expect(useLayoutStore.getState().rightDrawer.autoCollapse).toBe(true);
    expect(useLayoutStore.getState().leftDrawer.open).toBe(true);
    expect(useLayoutStore.getState().rightDrawer.open).toBe(true);
    expect(readDrawerPrefs()).toMatchObject({
      leftAutoCollapse: true,
      rightAutoCollapse: true,
    });

    // Blur auto-collapse collapses both open auto-collapse drawers
    layoutService.autoCollapseDrawer('left');
    layoutService.autoCollapseDrawer('right');
    expect(useLayoutStore.getState().leftDrawer.open).toBe(false);
    expect(useLayoutStore.getState().rightDrawer.open).toBe(false);

    // Pinning left drawer back updates localStorage preference
    layoutService.toggleDrawerAutoCollapse('left');
    expect(useLayoutStore.getState().leftDrawer.autoCollapse).toBe(false);
    expect(readDrawerPrefs()).toMatchObject({
      leftAutoCollapse: false,
      rightAutoCollapse: true,
    });
  });

  it('computes flat percentage slots and separator bounds with stable group ordering', () => {
    expect(computeFlatDockLayout(null)).toEqual({ groups: [], separators: [] });

    const flat = computeFlatDockLayout({
      type: 'split',
      id: 'split-v',
      direction: 'vertical',
      ratio: 0.7,
      first: {
        type: 'split',
        id: 'split-h',
        direction: 'horizontal',
        ratio: 0.4,
        first: {
          type: 'group',
          id: 'grp-z',
          viewportIds: ['vp-z'],
          activeViewportId: 'vp-z',
        },
        second: {
          type: 'group',
          id: 'grp-a',
          viewportIds: ['vp-a'],
          activeViewportId: 'vp-a',
        },
      },
      second: {
        type: 'group',
        id: 'grp-m',
        viewportIds: ['vp-m'],
        activeViewportId: 'vp-m',
      },
    });

    expect(flat.groups.map((g) => g.group.id)).toEqual(['grp-a', 'grp-m', 'grp-z']);
    const byId = Object.fromEntries(flat.groups.map((g) => [g.group.id, g]));
    expect(byId['grp-z']).toMatchObject({ left: 0, top: 0, width: 40, height: 70 });
    expect(byId['grp-a']).toMatchObject({ left: 40, top: 0, width: 60, height: 70 });
    expect(byId['grp-m']).toMatchObject({ left: 0, top: 70, width: 100, height: 30 });

    expect(flat.separators).toEqual([
      {
        splitId: 'split-v',
        direction: 'vertical',
        left: 0,
        top: 70,
        length: 100,
        branchLeft: 0,
        branchTop: 0,
        branchWidth: 100,
        branchHeight: 100,
      },
      {
        splitId: 'split-h',
        direction: 'horizontal',
        left: 40,
        top: 0,
        length: 70,
        branchLeft: 0,
        branchTop: 0,
        branchWidth: 100,
        branchHeight: 70,
      },
    ]);
  });
});
