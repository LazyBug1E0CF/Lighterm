import type { PreferredDockPosition, ViewportInstanceRef } from '../harness/types';
import type { SplitDirection } from '../types';

export type DrawerSide = 'left' | 'right';
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export type DockZone = 'center' | DockEdge;

export interface DrawerState {
  open: boolean;
  width: number;
  viewportIds: string[];
  activeViewportId: string | null;
}

export type ViewportInstance = ViewportInstanceRef;

export interface DockGroupNode {
  type: 'group';
  id: string;
  viewportIds: string[];
  activeViewportId: string;
}

export interface DockSplitNode {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: DockNode;
  second: DockNode;
}

export type DockNode = DockGroupNode | DockSplitNode;

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingViewportItem extends FloatingRect {
  viewportId: string;
  zIndex: number;
}

export type SnapTarget =
  | { kind: 'drawer'; side: DrawerSide }
  | { kind: 'edge'; edge: DockEdge }
  | { kind: 'group'; groupId: string; zone: DockZone };

export interface ViewportDragState {
  viewportId: string;
  source: 'docked' | 'floating' | 'drawer';
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
  floatOffsetX: number;
  floatOffsetY: number;
  snapTarget: SnapTarget | null;
}

export interface OpenViewportOptions {
  id?: string;
  typeId: string;
  pluginId: string;
  title: string;
  params?: Record<string, unknown>;
  preferredDock?: PreferredDockPosition;
  activateDrawer?: boolean;
  targetGroupId?: string;
  splitZone?: DockZone;
  floatRect?: Partial<FloatingRect>;
}
