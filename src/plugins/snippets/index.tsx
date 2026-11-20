import { Code2 } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import type { LayoutService } from '../../layout/layoutStore';
import type { Snippet } from '../../types';
import { snippetsClient } from './snippetsClient';
import { SnippetsViewport } from './SnippetsViewport';

export const SNIPPETS_VIEWPORT_TYPE = 'snippets.panel';

export const snippetsPlugin: PluginDefinition = {
  id: 'lighterm.snippets',
  name: 'Command Snippets',
  version: '1.0.0',
  description: 'Reusable shell command templates with {{variable}} prompt support',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: SNIPPETS_VIEWPORT_TYPE,
      title: 'Snippets',
      icon: Code2,
      defaultDock: 'left-drawer',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      component: SnippetsViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: SNIPPETS_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'Snippets',
        preferredDock: 'left-drawer',
      });
    };

    ctx.registerCommand({
      id: 'snippets:toggle',
      group: 'Action',
      label: 'Toggle Snippets Viewport',
      run: toggle,
    });

    let dynDisposers: (() => void)[] = [];
    const syncCommands = (list: Snippet[]) => {
      dynDisposers.forEach((d) => d());
      dynDisposers = list.map((s) =>
        ctx.registerCommand({
          id: `snip-${s.id}`,
          group: 'Snippet',
          label: s.title,
          subtitle: s.command,
          run: () => shell.sendTextToActiveSession(s.command, s.autoExecute),
        }),
      );
    };

    const unsubChange = snippetsClient.onChange(syncCommands);
    ctx.onCleanup(() => {
      unsubChange();
      dynDisposers.forEach((d) => d());
      dynDisposers = [];
    });

    void snippetsClient.load().catch(() => {});
  },
};
