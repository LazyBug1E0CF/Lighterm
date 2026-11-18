import type { PaneLeaf, PaneNode, SplitDirection } from '../types';

export function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') {
    return [node];
  }
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function findFirstLeaf(node: PaneNode): PaneLeaf {
  if (node.type === 'leaf') {
    return node;
  }
  return findFirstLeaf(node.first);
}

export function findLeafById(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? node : null;
  }
  return findLeafById(node.first, paneId) ?? findLeafById(node.second, paneId);
}

export function splitPaneNode(
  node: PaneNode,
  targetPaneId: string,
  direction: SplitDirection,
  newLeaf: PaneLeaf,
  splitId: string,
): PaneNode {
  if (node.type === 'leaf') {
    if (node.id !== targetPaneId) {
      return node;
    }
    return {
      type: 'split',
      id: splitId,
      direction,
      ratio: 0.5,
      first: node,
      second: newLeaf,
    };
  }

  return {
    ...node,
    first: splitPaneNode(node.first, targetPaneId, direction, newLeaf, splitId),
    second: splitPaneNode(node.second, targetPaneId, direction, newLeaf, splitId),
  };
}

export function removePaneNode(node: PaneNode, targetPaneId: string): PaneNode | null {
  if (node.type === 'leaf') {
    return node.id === targetPaneId ? null : node;
  }

  const nextFirst = removePaneNode(node.first, targetPaneId);
  const nextSecond = removePaneNode(node.second, targetPaneId);

  if (nextFirst === null && nextSecond === null) {
    return null;
  }
  if (nextFirst === null) {
    return nextSecond;
  }
  if (nextSecond === null) {
    return nextFirst;
  }

  return {
    ...node,
    first: nextFirst,
    second: nextSecond,
  };
}

export function updateSplitRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));
  if (node.type === 'leaf') {
    return node;
  }
  if (node.id === splitId) {
    return { ...node, ratio: clamped };
  }
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, clamped),
    second: updateSplitRatio(node.second, splitId, clamped),
  };
}

export function updateLeafTitle(node: PaneNode, sessionId: string, title: string): PaneNode {
  if (node.type === 'leaf') {
    return node.sessionId === sessionId ? { ...node, title } : node;
  }
  return {
    ...node,
    first: updateLeafTitle(node.first, sessionId, title),
    second: updateLeafTitle(node.second, sessionId, title),
  };
}
