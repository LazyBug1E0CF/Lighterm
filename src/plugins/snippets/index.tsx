import { Code2 } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import { definePlugin } from '../../kernel';
import type { LayoutService } from '../../layout/layoutStore';
import type { Snippet } from '../../types';
import {
  DEFAULT_SNIPPETS_CONFIG,
  snippetsClient,
  type SnippetsPluginConfig,
} from './snippetsClient';
import { SnippetsSettingsPage } from './SnippetsSettingsPage';
import { SnippetsViewport } from './SnippetsViewport';

export { DEFAULT_SNIPPETS_CONFIG, type SnippetsPluginConfig };
export const SNIPPETS_VIEWPORT_TYPE = 'snippets.panel';

export const snippetsPlugin = definePlugin({
  id: 'lighterm.snippets',
  name: 'Command Snippets',
  version: '1.0.0',
  description: 'Reusable shell command templates with {{variable}} prompt support',
  icon: Code2,
  author: 'Lighterm',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: SNIPPETS_VIEWPORT_TYPE,
      title: 'Snippets',
      icon: Code2,
      defaultPosition: 'left-drawer',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      openOnStartup: true,
      activateOnStartup: false,
      order: 20,
      component: SnippetsViewport,
    });

    ctx.registerSettingsPage({
      id: 'snippets',
      title: 'Snippets',
      description: 'Configure default category and execution behavior for newly created snippets.',
      icon: Code2,
      order: 40,
      component: SnippetsSettingsPage,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({ typeId: SNIPPETS_VIEWPORT_TYPE });
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
    const unsubMutated = snippetsClient.onMutated(() => {
      shell.notifyConfigMutated('snippets');
    });
    const unsubReload = shell.onConfigReloaded(() => {
      void snippetsClient.load().catch(() => {});
    });
    ctx.onCleanup(() => {
      unsubChange();
      unsubMutated();
      unsubReload();
      dynDisposers.forEach((d) => d());
      dynDisposers = [];
    });

    void snippetsClient.load().catch(() => {});
  },
});
