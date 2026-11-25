import type { PreferredDockPosition, ViewportInstanceRef } from '../kernel/types';
import type { QuickShellLayoutPreset, SplitDirection } from '../types';

export type DrawerSide = 'left' | 'right';
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export type DockZone = 'center' | DockEdge;
export type { QuickShellLayoutPreset };

export interface WorkspaceState {
  id: string;
  name: string;
  savedWorkspaceId?: string | null;
  dockRoot: DockNode | null;
  floating: FloatingViewportItem[];
  activeViewportId: string | null;
  maximizedViewportId: string | null;
  layoutPreset: QuickShellLayoutPreset | null;
}

export interface DrawerState {
  open: boolean;
  width: number;
  autoCollapse: boolean;
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

export interface TearOffViewportSpec {
  typeId: string;
  pluginId?: string;
  title?: string;
  params?: Record<string, unknown>;
  dockRatio?: number;
  floatRect?: Partial<FloatingRect>;
  originViewportId?: string;
  onCommit?: (viewport: ViewportInstance) => void;
  onCancel?: () => void;
}

export interface StartTearOffDragOptions extends TearOffViewportSpec {
  startX: number;
  startY: number;
  currentX?: number;
  currentY?: number;
  floatOffsetX?: number;
  floatOffsetY?: number;
  active?: boolean;
}

export interface ViewportDragState {
  viewportId: string;
  source: 'docked' | 'floating' | 'drawer' | 'tear-off';
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  active: boolean;
  floatOffsetX: number;
  floatOffsetY: number;
  snapTarget: SnapTarget | null;
  tearOff?: TearOffViewportSpec;
}

export interface OpenViewportOptions {
  id?: string;
  typeId: string;
  pluginId?: string;
  title?: string;
  params?: Record<string, unknown>;
  preferredDock?: PreferredDockPosition;
  dockRatio?: number;
  activateDrawer?: boolean;
  targetGroupId?: string;
  splitZone?: DockZone;
  floatRect?: Partial<FloatingRect>;
}
