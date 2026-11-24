import { makeUuid } from '../core/ipc';
import type { SplitDirection } from '../types';
import type {
  DockEdge,
  DockGroupNode,
  DockNode,
  DockZone,
  QuickShellLayoutPreset,
} from './types';

export function collectGroups(node: DockNode | null): DockGroupNode[] {
  if (!node) return [];
  if (node.type === 'group') return [node];
  return [...collectGroups(node.first), ...collectGroups(node.second)];
}

export function findGroupById(node: DockNode | null, groupId: string): DockGroupNode | null {
  if (!node) return null;
  if (node.type === 'group') return node.id === groupId ? node : null;
  return findGroupById(node.first, groupId) ?? findGroupById(node.second, groupId);
}

export function findGroupContainingViewport(
  node: DockNode | null,
  viewportId: string,
): DockGroupNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    return node.viewportIds.includes(viewportId) ? node : null;
  }
  return (
    findGroupContainingViewport(node.first, viewportId) ??
    findGroupContainingViewport(node.second, viewportId)
  );
}

export function findFirstGroup(node: DockNode | null): DockGroupNode | null {
  if (!node) return null;
  if (node.type === 'group') return node;
  return findFirstGroup(node.first) ?? findFirstGroup(node.second);
}

export function createGroup(viewportId: string, groupId = makeUuid('grp')): DockGroupNode {
  return {
    type: 'group',
    id: groupId,
    viewportIds: [viewportId],
    activeViewportId: viewportId,
  };
}

export function setActiveViewportInGroup(
  node: DockNode | null,
  groupId: string,
  viewportId: string,
): DockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    if (node.id !== groupId || !node.viewportIds.includes(viewportId)) return node;
    return { ...node, activeViewportId: viewportId };
  }
  return {
    ...node,
    first: setActiveViewportInGroup(node.first, groupId, viewportId)!,
    second: setActiveViewportInGroup(node.second, groupId, viewportId)!,
  };
}

export function setActiveViewportInTree(
  node: DockNode | null,
  viewportId: string,
): DockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    if (!node.viewportIds.includes(viewportId)) return node;
    return { ...node, activeViewportId: viewportId };
  }
  return {
    ...node,
    first: setActiveViewportInTree(node.first, viewportId)!,
    second: setActiveViewportInTree(node.second, viewportId)!,
  };
}

export function removeViewportFromTree(
  node: DockNode | null,
  viewportId: string,
): DockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    if (!node.viewportIds.includes(viewportId)) {
      return node;
    }
    const idx = node.viewportIds.indexOf(viewportId);
    const remaining = node.viewportIds.filter((id) => id !== viewportId);
    if (remaining.length === 0) {
      return null;
    }
    const nextActive =
      node.activeViewportId === viewportId
        ? remaining[Math.min(idx, remaining.length - 1)]
        : node.activeViewportId;
    return {
      ...node,
      viewportIds: remaining,
      activeViewportId: nextActive,
    };
  }

  const nextFirst = removeViewportFromTree(node.first, viewportId);
  const nextSecond = removeViewportFromTree(node.second, viewportId);

  if (!nextFirst && !nextSecond) return null;
  if (!nextFirst) return nextSecond;
  if (!nextSecond) return nextFirst;

  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  };
}

export function dockViewportAtEdge(
  node: DockNode | null,
  viewportId: string,
  edge: DockEdge,
  ratio?: number,
): DockNode {
  const cleaned = removeViewportFromTree(node, viewportId);
  const newGroup = createGroup(viewportId);

  if (!cleaned) {
    return newGroup;
  }

  const defaultRatio =
    edge === 'left' ? 0.22 : edge === 'right' ? 0.76 : edge === 'top' ? 0.3 : 0.68;
  const clamped = Math.max(0.1, Math.min(0.9, ratio ?? defaultRatio));

  if (edge === 'left') {
    return {
      type: 'split',
      id: makeUuid('split'),
      direction: 'horizontal',
      ratio: clamped,
      first: newGroup,
      second: cleaned,
    };
  }
  if (edge === 'right') {
    return {
      type: 'split',
      id: makeUuid('split'),
      direction: 'horizontal',
      ratio: clamped,
      first: cleaned,
      second: newGroup,
    };
  }
  if (edge === 'top') {
    return {
      type: 'split',
      id: makeUuid('split'),
      direction: 'vertical',
      ratio: clamped,
      first: newGroup,
      second: cleaned,
    };
  }
  return {
    type: 'split',
    id: makeUuid('split'),
    direction: 'vertical',
    ratio: clamped,
    first: cleaned,
    second: newGroup,
  };
}

function insertIntoTargetGroup(
  node: DockNode,
  viewportId: string,
  targetGroupId: string,
  zone: DockZone,
  ratio: number,
): { node: DockNode; inserted: boolean } {
  if (node.type === 'group') {
    if (node.id !== targetGroupId) {
      return { node, inserted: false };
    }
    if (zone === 'center') {
      const nextIds = node.viewportIds.includes(viewportId)
        ? node.viewportIds
        : [...node.viewportIds, viewportId];
      return {
        node: {
          ...node,
          viewportIds: nextIds,
          activeViewportId: viewportId,
        },
        inserted: true,
      };
    }

    const newGroup = createGroup(viewportId);
    const direction = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical';
    const isFirst = zone === 'left' || zone === 'top';
    const clamped = Math.max(0.1, Math.min(0.9, ratio));
    return {
      node: {
        type: 'split',
        id: makeUuid('split'),
        direction,
        ratio: clamped,
        first: isFirst ? newGroup : node,
        second: isFirst ? node : newGroup,
      },
      inserted: true,
    };
  }

  const firstRes = insertIntoTargetGroup(node.first, viewportId, targetGroupId, zone, ratio);
  if (firstRes.inserted) {
    return { node: { ...node, first: firstRes.node }, inserted: true };
  }
  const secondRes = insertIntoTargetGroup(node.second, viewportId, targetGroupId, zone, ratio);
  if (secondRes.inserted) {
    return { node: { ...node, second: secondRes.node }, inserted: true };
  }
  return { node, inserted: false };
}

export function dockViewportInGroup(
  node: DockNode | null,
  viewportId: string,
  targetGroupId: string,
  zone: DockZone,
  ratio = 0.5,
): DockNode {
  const existingTarget = findGroupById(node, targetGroupId);
  if (
    existingTarget &&
    existingTarget.viewportIds.length === 1 &&
    existingTarget.viewportIds[0] === viewportId
  ) {
    return node!;
  }

  const cleaned = removeViewportFromTree(node, viewportId);
  if (!cleaned) {
    return createGroup(viewportId);
  }

  const res = insertIntoTargetGroup(cleaned, viewportId, targetGroupId, zone, ratio);
  if (res.inserted) {
    return res.node;
  }

  const fallbackEdge: DockEdge = zone === 'center' ? 'right' : zone;
  return dockViewportAtEdge(cleaned, viewportId, fallbackEdge, ratio);
}

export function updateDockSplitRatio(
  node: DockNode | null,
  splitId: string,
  ratio: number,
): DockNode | null {
  if (!node) return null;
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  if (node.type === 'group') return node;
  if (node.id === splitId) {
    return { ...node, ratio: clamped };
  }
  return {
    ...node,
    first: updateDockSplitRatio(node.first, splitId, clamped)!,
    second: updateDockSplitRatio(node.second, splitId, clamped)!,
  };
}

export function pruneUnavailableViewports(
  node: DockNode | null,
  isAvailable: (viewportId: string) => boolean,
): DockNode | null {
  if (!node) return null;
  if (node.type === 'group') {
    const visibleIds = node.viewportIds.filter(isAvailable);
    if (visibleIds.length === 0) return null;
    const active = visibleIds.includes(node.activeViewportId)
      ? node.activeViewportId
      : visibleIds[0];
    return {
      ...node,
      viewportIds: visibleIds,
      activeViewportId: active,
    };
  }

  const first = pruneUnavailableViewports(node.first, isAvailable);
  const second = pruneUnavailableViewports(node.second, isAvailable);
  if (!first && !second) return null;
  if (!first) return second;
  if (!second) return first;
  return {
    ...node,
    first,
    second,
  };
}

/** Recursively nests equal-sized binary splits so N sibling nodes share equal space. */
export function buildLinearSplitFromNodes(
  nodes: DockNode[],
  direction: SplitDirection,
): DockNode | null {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  const [first, ...rest] = nodes;
  const second = buildLinearSplitFromNodes(rest, direction);
  if (!second) return first;
  const ratio = Math.max(0.1, Math.min(0.9, 1 / nodes.length));
  return {
    type: 'split',
    id: makeUuid('split'),
    direction,
    ratio,
    first,
    second,
  };
}

/** Builds a docked layout tree arranging the given viewport IDs in tab, vsp, hsp, or grid form. */
export function buildPresetDockTree(
  viewportIds: string[],
  preset: QuickShellLayoutPreset,
  preferredActiveId?: string | null,
): DockNode | null {
  if (viewportIds.length === 0) return null;

  if (preset === 'tab' || viewportIds.length === 1) {
    const activeViewportId =
      preferredActiveId && viewportIds.includes(preferredActiveId)
        ? preferredActiveId
        : viewportIds[0];
    return {
      type: 'group',
      id: makeUuid('grp'),
      viewportIds: [...viewportIds],
      activeViewportId,
    };
  }

  if (preset === 'vsp') {
    return buildLinearSplitFromNodes(
      viewportIds.map((vid) => createGroup(vid)),
      'horizontal',
    );
  }

  if (preset === 'hsp') {
    return buildLinearSplitFromNodes(
      viewportIds.map((vid) => createGroup(vid)),
      'vertical',
    );
  }

  const cols = Math.ceil(Math.sqrt(viewportIds.length));
  const rows: DockNode[] = [];
  for (let i = 0; i < viewportIds.length; i += cols) {
    const rowSlice = viewportIds.slice(i, i + cols).map((vid) => createGroup(vid));
    const rowNode = buildLinearSplitFromNodes(rowSlice, 'horizontal');
    if (rowNode) rows.push(rowNode);
  }
  return buildLinearSplitFromNodes(rows, 'vertical');
}

export interface DockGroupLayoutSlot {
  group: DockGroupNode;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockSplitSeparatorSlot {
  splitId: string;
  direction: SplitDirection;
  left: number;
  top: number;
  length: number;
  branchLeft: number;
  branchTop: number;
  branchWidth: number;
  branchHeight: number;
}

export interface FlatDockLayout {
  groups: DockGroupLayoutSlot[];
  separators: DockSplitSeparatorSlot[];
}

/**
 * Computes flat percentage coordinates for every docked group and split separator
 * so DockGroupView instances stay at a constant React tree depth across splits and closes.
 */
export function computeFlatDockLayout(root: DockNode | null): FlatDockLayout {
  const groups: DockGroupLayoutSlot[] = [];
  const separators: DockSplitSeparatorSlot[] = [];
  if (!root) {
    return { groups, separators };
  }

  const visit = (
    node: DockNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void => {
    if (node.type === 'group') {
      groups.push({ group: node, left, top, width, height });
      return;
    }

    if (node.direction === 'horizontal') {
      const firstWidth = width * node.ratio;
      const secondWidth = width - firstWidth;
      const splitX = left + firstWidth;
      separators.push({
        splitId: node.id,
        direction: 'horizontal',
        left: splitX,
        top,
        length: height,
        branchLeft: left,
        branchTop: top,
        branchWidth: width,
        branchHeight: height,
      });
      visit(node.first, left, top, firstWidth, height);
      visit(node.second, splitX, top, secondWidth, height);
      return;
    }

    const firstHeight = height * node.ratio;
    const secondHeight = height - firstHeight;
    const splitY = top + firstHeight;
    separators.push({
      splitId: node.id,
      direction: 'vertical',
      left,
      top: splitY,
      length: width,
      branchLeft: left,
      branchTop: top,
      branchWidth: width,
      branchHeight: height,
    });
    visit(node.first, left, top, width, firstHeight);
    visit(node.second, left, splitY, width, secondHeight);
  };

  visit(root, 0, 0, 100, 100);
  groups.sort((a, b) => a.group.id.localeCompare(b.group.id));
  return { groups, separators };
}
