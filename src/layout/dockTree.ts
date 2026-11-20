import { makeUuid } from '../core/ipc';
import type { DockEdge, DockGroupNode, DockNode, DockZone } from './types';

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
