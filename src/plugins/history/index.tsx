import React from 'react';
import { History } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, useLayoutStore } from '../../layout/layoutStore';
import type { HistoryEntry } from '../../types';
import { CommandTracker } from '../../utils/commandTracker';
import { historyClient } from './historyClient';
import { HistoryViewport } from './HistoryViewport';

export const HISTORY_VIEWPORT_TYPE = 'history.panel';

const HistoryTopBarButton: React.FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const isOpen = useLayoutStore((s) =>
    Object.values(s.viewports).some((v) => v.typeId === HISTORY_VIEWPORT_TYPE),
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle Command History Viewport"
      aria-label="Command History"
      className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
        isOpen
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <History className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">History</span>
    </button>
  );
};

export const historyPlugin: PluginDefinition = {
  id: 'lighterm.history',
  name: 'Command History',
  version: '1.0.0',
  description: 'Tracks submitted shell commands directly from core shell I/O streams',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  async activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    const trackers = new Map<string, CommandTracker>();
    const getTracker = (sessionId: string) => {
      let tracker = trackers.get(sessionId);
      if (!tracker) {
        tracker = new CommandTracker();
        trackers.set(sessionId, tracker);
      }
      return tracker;
    };

    const unsubOutput = shell.onSessionOutput((sessionId, bytes) => {
      getTracker(sessionId).feedOutput(bytes);
    });
    const unsubInput = shell.onSessionInput((sessionId, text) => {
      const cmds = getTracker(sessionId).feedInput(text);
      if (cmds.length === 0) return;
      const session = shell.getSession(sessionId);
      const kind = session?.info.kind ?? 'local';
      const label = session?.info.title ?? 'Local';
      for (const cmd of cmds) {
        void historyClient.record(cmd, kind, label);
      }
    });
    const unsubClosed = shell.onSessionClosed((sessionId) => {
      trackers.delete(sessionId);
    });

    ctx.registerViewport({
      typeId: HISTORY_VIEWPORT_TYPE,
      title: 'Command History',
      icon: History,
      defaultDock: 'left',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      component: HistoryViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: HISTORY_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'Command History',
        preferredDock: 'left',
      });
    };

    ctx.registerSlot({
      id: 'history-topbar-btn',
      slot: 'topbar:right',
      order: 24,
      render: () => <HistoryTopBarButton onToggle={toggle} />,
    });

    ctx.registerCommand({
      id: 'history:toggle',
      group: 'Action',
      label: 'Toggle Command History Viewport',
      run: toggle,
    });

    let dynDisposers: (() => void)[] = [];
    const syncCommands = (entries: HistoryEntry[]) => {
      dynDisposers.forEach((d) => d());
      dynDisposers = entries.slice(0, 20).map((h) =>
        ctx.registerCommand({
          id: `hist-${h.id}`,
          group: 'History',
          label: h.command,
          subtitle: h.hostLabel,
          run: () => shell.sendTextToActiveSession(h.command, true),
        }),
      );
    };

    const unsubChange = historyClient.onChange(syncCommands);
    ctx.onCleanup(() => {
      unsubOutput();
      unsubInput();
      unsubClosed();
      unsubChange();
      trackers.clear();
      dynDisposers.forEach((d) => d());
      dynDisposers = [];
    });

    await historyClient.load().catch(() => {});
  },
};
