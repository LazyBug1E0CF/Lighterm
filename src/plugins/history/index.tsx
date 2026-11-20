import { History } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import type { LayoutService } from '../../layout/layoutStore';
import type { HistoryEntry } from '../../types';
import { CommandTracker } from '../../utils/commandTracker';
import { historyClient } from './historyClient';
import { HistoryViewport } from './HistoryViewport';

export const HISTORY_VIEWPORT_TYPE = 'history.panel';

export const historyPlugin: PluginDefinition = {
  id: 'lighterm.history',
  name: 'Command History',
  version: '1.0.0',
  description: 'Tracks submitted shell commands directly from core shell I/O streams',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
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
      defaultDock: 'left-drawer',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      component: HistoryViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: HISTORY_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'Command History',
        preferredDock: 'left-drawer',
      });
    };

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

    void historyClient.load().catch(() => {});
  },
};
