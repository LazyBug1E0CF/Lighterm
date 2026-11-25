import React from 'react';
import { Columns2, Rows2, Terminal } from 'lucide-react';
import { type ShellService, useShellStore } from '../../core/shellService';
import { definePlugin } from '../../harness';
import type { LayoutService } from '../../layout/layoutStore';
import { matchesShortcut } from '../../utils/shortcuts';
import { TERMINAL_VIEWPORT_TYPE, TerminalPluginService } from './terminalService';
import { TerminalSettingsTab } from './TerminalSettingsTab';
import { TerminalViewport } from './TerminalViewport';

export { TERMINAL_VIEWPORT_TYPE };
export const TERMINAL_SETTINGS_PAGE_KEY = 'lighterm.terminal:terminal';

const TerminalDimensionsBadge: React.FC = () => {
  const activeSessionId = useShellStore((s) => s.activeSessionId);
  const dims = useShellStore((s) =>
    activeSessionId ? s.sessionDimensions[activeSessionId] : undefined,
  );
  if (!dims) return null;
  return (
    <span className="font-mono text-[var(--text-muted)] hidden sm:inline">
      {dims.cols}×{dims.rows}
    </span>
  );
};

export const terminalPlugin = definePlugin({
  id: 'lighterm.terminal',
  name: 'Terminal Viewport',
  version: '1.0.0',
  description: 'Interactive xterm.js terminal viewport with split panes, search, and settings',
  icon: Terminal,
  author: 'Lighterm',
  inject: ['core:shell', 'core:layout'],
  provides: ['terminal:service'],
  defaultEnabled: true,
  alwaysOn: true,

  activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    const service = new TerminalPluginService(shell, layout);
    ctx.provide('terminal:service', service);

    const openViewportForSession = (
      sessionId: string,
      title: string,
      meta?: Record<string, unknown>,
    ) => {
      const existing = layout
        .findViewportsByType(TERMINAL_VIEWPORT_TYPE)
        .find((vp) => String(vp.params?.sessionId ?? '') === sessionId);
      if (existing) {
        if (layout.getWorkspaceViewportIds().includes(existing.id)) {
          layout.setActiveViewport(existing.id);
        }
        return;
      }

      const targetDrawer =
        meta?.targetDrawer === 'left' || meta?.targetDrawer === 'right'
          ? meta.targetDrawer
          : undefined;

      if (targetDrawer) {
        layout.openViewport({
          typeId: TERMINAL_VIEWPORT_TYPE,
          pluginId: ctx.pluginId,
          title,
          params: { sessionId },
          preferredDock: targetDrawer === 'left' ? 'left-drawer' : 'right-drawer',
        });
        return;
      }

      const splitFromViewportId =
        typeof meta?.splitFromViewportId === 'string' ? meta.splitFromViewportId : undefined;
      const splitDirection =
        meta?.splitDirection === 'horizontal' || meta?.splitDirection === 'vertical'
          ? meta.splitDirection
          : undefined;

      const targetGroup = splitFromViewportId
        ? layout.findGroupForViewport(splitFromViewportId)
        : null;

      layout.openViewport({
        typeId: TERMINAL_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title,
        params: { sessionId },
        preferredDock: 'center',
        targetGroupId: targetGroup?.id,
        splitZone:
          targetGroup && splitDirection
            ? splitDirection === 'horizontal'
              ? 'right'
              : 'bottom'
            : undefined,
      });
    };

    ctx.registerViewport({
      typeId: TERMINAL_VIEWPORT_TYPE,
      title: 'Terminal',
      icon: Terminal,
      defaultPosition: 'center',
      defaultFloatSize: { width: 680, height: 420 },
      singleton: false,
      component: TerminalViewport,
      onClose: (vp) => {
        const sid = String(vp.params?.sessionId ?? '');
        if (sid && shell.getSession(sid)) {
          void shell.closeSession(sid);
        }
      },
    });

    // Bind any already-active shell sessions when plugin activates/re-enables
    for (const rec of shell.listSessions()) {
      openViewportForSession(rec.info.id, rec.info.title);
    }

    const unsubCreate = shell.onSessionCreated((record, meta) => {
      if ((meta as { skipAutoViewport?: boolean } | undefined)?.skipAutoViewport) {
        return;
      }
      openViewportForSession(record.info.id, record.info.title, meta);
    });
    const unsubClose = shell.onSessionClosed((sessionId) => {
      const vp = layout
        .findViewportsByType(TERMINAL_VIEWPORT_TYPE)
        .find((v) => String(v.params?.sessionId ?? '') === sessionId);
      if (vp) {
        layout.closeViewport(vp.id);
      }
    });
    ctx.onCleanup(unsubCreate);
    ctx.onCleanup(unsubClose);

    ctx.registerSlot({
      id: 'terminal-split-h',
      slot: 'topbar:right',
      order: 10,
      render: () => (
        <button
          type="button"
          onClick={() => void service.splitActive('horizontal')}
          title="Split Horizontally (Ctrl+Shift+D)"
          aria-label="Split Horizontally"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Columns2 className="w-4 h-4" />
        </button>
      ),
    });

    ctx.registerSlot({
      id: 'terminal-split-v',
      slot: 'topbar:right',
      order: 11,
      render: () => (
        <button
          type="button"
          onClick={() => void service.splitActive('vertical')}
          title="Split Vertically (Ctrl+Shift+E)"
          aria-label="Split Vertically"
          className="h-7 w-7 rounded-md flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition-colors"
        >
          <Rows2 className="w-4 h-4" />
        </button>
      ),
    });

    ctx.registerSlot({
      id: 'terminal-host-split',
      slot: 'host:actions',
      order: 10,
      render: (context) =>
        context?.host ? (
          <button
            type="button"
            onClick={() => void service.splitActive('horizontal', context.host)}
            title="Open in Split Pane"
            className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-app)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
          >
            <Columns2 className="w-2.5 h-2.5" />
            Split
          </button>
        ) : null,
    });

    ctx.registerSlot({
      id: 'terminal-dims',
      slot: 'statusbar:left',
      order: 10,
      render: () => <TerminalDimensionsBadge />,
    });

    ctx.registerSettingsPage({
      id: 'terminal',
      title: 'Terminal',
      description: 'Configure terminal font, cursor style, scrollback buffer, and selection behavior.',
      icon: Terminal,
      order: 10,
      component: TerminalSettingsTab,
    });

    ctx.registerCommand({
      id: 'terminal:split-h',
      group: 'Action',
      label: 'Split Active Pane Horizontally',
      run: () => service.splitActive('horizontal'),
    });
    ctx.registerCommand({
      id: 'terminal:split-v',
      group: 'Action',
      label: 'Split Active Pane Vertically',
      run: () => service.splitActive('vertical'),
    });
    ctx.registerCommand({
      id: 'terminal:find',
      group: 'Action',
      label: 'Find in Terminal',
      run: () => service.triggerSearch(),
    });
    ctx.registerCommand({
      id: 'terminal:layout-tab',
      group: 'Layout',
      label: 'Layout: Tab',
      run: () => layout.arrangeWorkspaceShells('tab'),
    });
    ctx.registerCommand({
      id: 'terminal:layout-vsp',
      group: 'Layout',
      label: 'Layout: Vertical Split (VSP)',
      run: () => layout.arrangeWorkspaceShells('vsp'),
    });
    ctx.registerCommand({
      id: 'terminal:layout-hsp',
      group: 'Layout',
      label: 'Layout: Horizontal Split (HSP)',
      run: () => layout.arrangeWorkspaceShells('hsp'),
    });
    ctx.registerCommand({
      id: 'terminal:layout-grid',
      group: 'Layout',
      label: 'Layout: Grid',
      run: () => layout.arrangeWorkspaceShells('grid'),
    });

    const onKeyDown = (e: KeyboardEvent) => {
      const sc = useShellStore.getState().settings.shortcuts;
      if (matchesShortcut(e, sc.splitHorizontal)) {
        e.preventDefault();
        void service.splitActive('horizontal');
      } else if (matchesShortcut(e, sc.splitVertical)) {
        e.preventDefault();
        void service.splitActive('vertical');
      } else if (matchesShortcut(e, sc.closePane)) {
        e.preventDefault();
        service.closeActiveTerminal();
      } else if (matchesShortcut(e, sc.findInTerminal)) {
        e.preventDefault();
        service.triggerSearch();
      } else if (matchesShortcut(e, sc.nextTab)) {
        e.preventDefault();
        service.cycleTerminalViewport(1);
      } else if (matchesShortcut(e, sc.prevTab)) {
        e.preventDefault();
        service.cycleTerminalViewport(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
});
