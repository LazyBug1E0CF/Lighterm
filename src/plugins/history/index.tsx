import { History } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import { definePlugin, pluginKernel } from '../../kernel';
import type { LayoutService } from '../../layout/layoutStore';
import type { HistoryEntry } from '../../types';
import { CommandTracker } from '../../utils/commandTracker';
import {
  DEFAULT_HISTORY_CONFIG,
  historyClient,
  useHistoryPluginStore,
  type HistoryPluginConfig,
} from './historyClient';
import { HistorySettingsPage } from './HistorySettingsPage';
import { HistoryViewport } from './HistoryViewport';

export { DEFAULT_HISTORY_CONFIG, type HistoryPluginConfig };
export const HISTORY_VIEWPORT_TYPE = 'history.panel';

export const historyPlugin = definePlugin({
  id: 'lighterm.history',
  name: 'Command History',
  version: '1.0.0',
  description: 'Tracks submitted shell commands directly from core shell I/O streams',
  icon: History,
  author: 'Lighterm',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,
  alwaysOn: true,

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
      defaultPosition: 'left-drawer',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      openOnStartup: true,
      activateOnStartup: false,
      order: 30,
      component: HistoryViewport,
    });

    ctx.registerSettingsPage({
      id: 'history',
      title: 'Command History',
      description: 'Configure history entry limits, Command Palette suggestions, and cleanup.',
      icon: History,
      order: 50,
      mountTo: 'lighterm.terminal:terminal',
      component: HistorySettingsPage,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({ typeId: HISTORY_VIEWPORT_TYPE });
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
      const rawLimit = Number(ctx.getConfig(DEFAULT_HISTORY_CONFIG).paletteHistoryLimit);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(0, rawLimit)
        : DEFAULT_HISTORY_CONFIG.paletteHistoryLimit;
      dynDisposers = entries.slice(0, limit).map((h) =>
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
    let prevPaletteLimit = ctx.getConfig(DEFAULT_HISTORY_CONFIG).paletteHistoryLimit;
    const unsubConfig = pluginKernel.subscribe(() => {
      if (!pluginKernel.isPluginActive(ctx.pluginId)) return;
      const nextLimit = ctx.getConfig(DEFAULT_HISTORY_CONFIG).paletteHistoryLimit;
      if (nextLimit !== prevPaletteLimit) {
        prevPaletteLimit = nextLimit;
        queueMicrotask(() => {
          if (pluginKernel.isPluginActive(ctx.pluginId)) {
            syncCommands(useHistoryPluginStore.getState().history);
          }
        });
      }
    });

    ctx.onCleanup(() => {
      unsubOutput();
      unsubInput();
      unsubClosed();
      unsubChange();
      unsubConfig();
      trackers.clear();
      dynDisposers.forEach((d) => d());
      dynDisposers = [];
    });

    const initialCfg = ctx.getConfig(DEFAULT_HISTORY_CONFIG);
    const maxDisplay = Math.max(
      10,
      Number(initialCfg.maxDisplayEntries) || DEFAULT_HISTORY_CONFIG.maxDisplayEntries,
    );
    void historyClient.load(undefined, maxDisplay).catch(() => {});
  },
});
