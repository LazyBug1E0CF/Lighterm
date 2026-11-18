import { describe, expect, it } from 'vitest';
import type { PaneLeaf } from '../types';
import {
  collectLeaves,
  removePaneNode,
  splitPaneNode,
  updateSplitRatio,
} from '../utils/paneTree';

const leaf = (id: string): PaneLeaf => ({
  type: 'leaf',
  id,
  sessionId: `sess-${id}`,
  kind: 'local',
  title: `Pane ${id}`,
});

describe('paneTree helpers', () => {
  it('splits horizontally and vertically and collects all leaves', () => {
    const root1 = leaf('p1');
    const splitH = splitPaneNode(root1, 'p1', 'horizontal', leaf('p2'), 's1');
    expect(splitH.type).toBe('split');
    expect(collectLeaves(splitH).map((l) => l.id)).toEqual(['p1', 'p2']);

    const splitHV = splitPaneNode(splitH, 'p2', 'vertical', leaf('p3'), 's2');
    expect(collectLeaves(splitHV).map((l) => l.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('collapses sibling cleanly when removing nested pane', () => {
    const tree = splitPaneNode(
      splitPaneNode(leaf('p1'), 'p1', 'horizontal', leaf('p2'), 's1'),
      'p2',
      'vertical',
      leaf('p3'),
      's2',
    );

    const afterRemove = removePaneNode(tree, 'p2');
    expect(afterRemove).not.toBeNull();
    expect(collectLeaves(afterRemove!).map((l) => l.id)).toEqual(['p1', 'p3']);

    const onlyRoot = removePaneNode(afterRemove!, 'p3');
    expect(onlyRoot?.type).toBe('leaf');
    expect(onlyRoot?.id).toBe('p1');

    expect(removePaneNode(onlyRoot!, 'p1')).toBeNull();
  });

  it('clamps split ratio within [0.15, 0.85]', () => {
    const tree = splitPaneNode(leaf('p1'), 'p1', 'horizontal', leaf('p2'), 's1');
    const clampedLow = updateSplitRatio(tree, 's1', 0.02);
    expect(clampedLow.type === 'split' ? clampedLow.ratio : 0).toBe(0.15);

    const clampedHigh = updateSplitRatio(tree, 's1', 0.99);
    expect(clampedHigh.type === 'split' ? clampedHigh.ratio : 0).toBe(0.85);
  });
});
