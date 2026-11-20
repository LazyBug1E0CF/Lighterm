import type { ShortcutMap } from '../types';

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  newLocalTab: 'Ctrl+Shift+T',
  newHostModal: 'Ctrl+Shift+N',
  splitHorizontal: 'Ctrl+Shift+D',
  splitVertical: 'Ctrl+Shift+E',
  closePane: 'Ctrl+Shift+W',
  findInTerminal: 'Ctrl+Shift+F',
  commandPalette: 'Ctrl+Shift+P',
  toggleSidebar: 'Ctrl+Shift+B',
  toggleSftp: 'Ctrl+Shift+S',
  toggleMonitor: 'Ctrl+Shift+M',
  openPlugins: 'Ctrl+Shift+X',
  openSettings: 'Ctrl+,',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
};

export function formatKeyboardEvent(e: KeyboardEvent): string | null {
  const ignoreKeys = new Set(['Control', 'Shift', 'Alt', 'Meta']);
  if (ignoreKeys.has(e.key)) {
    return null;
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');

  let keyName = e.key;
  if (keyName === ' ') keyName = 'Space';
  else if (keyName.length === 1) keyName = keyName.toUpperCase();

  parts.push(keyName);
  return parts.join('+');
}

export function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const normalized = shortcut.trim();
  if (!normalized) return false;
  const formatted = formatKeyboardEvent(e);
  if (!formatted) return false;
  return formatted.toLowerCase() === normalized.toLowerCase();
}
