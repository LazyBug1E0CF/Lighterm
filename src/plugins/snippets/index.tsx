import React from 'react';
import { Code2 } from 'lucide-react';
import type { ShellService } from '../../core/shellService';
import type { PluginDefinition } from '../../harness/types';
import { type LayoutService, useLayoutStore } from '../../layout/layoutStore';
import type { Snippet } from '../../types';
import { snippetsClient } from './snippetsClient';
import { SnippetsViewport } from './SnippetsViewport';

export const SNIPPETS_VIEWPORT_TYPE = 'snippets.panel';

const SnippetsTopBarButton: React.FC<{ onToggle: () => void }> = ({ onToggle }) => {
  const isOpen = useLayoutStore((s) =>
    Object.values(s.viewports).some((v) => v.typeId === SNIPPETS_VIEWPORT_TYPE),
  );
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Toggle Command Snippets Viewport"
      aria-label="Snippets"
      className={`h-7 px-2 rounded-md flex items-center gap-1 text-xs transition-colors ${
        isOpen
          ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40'
          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
      }`}
    >
      <Code2 className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">Snippets</span>
    </button>
  );
};

export const snippetsPlugin: PluginDefinition = {
  id: 'lighterm.snippets',
  name: 'Command Snippets',
  version: '1.0.0',
  description: 'Reusable shell command templates with {{variable}} prompt support',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  async activate(ctx) {
    const shell = ctx.inject<ShellService>('core:shell');
    const layout = ctx.inject<LayoutService>('core:layout');

    ctx.registerViewport({
      typeId: SNIPPETS_VIEWPORT_TYPE,
      title: 'Snippets',
      icon: Code2,
      defaultDock: 'left',
      defaultFloatSize: { width: 340, height: 460 },
      singleton: true,
      component: SnippetsViewport,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({
        typeId: SNIPPETS_VIEWPORT_TYPE,
        pluginId: ctx.pluginId,
        title: 'Snippets',
        preferredDock: 'left',
      });
    };

    ctx.registerSlot({
      id: 'snippets-topbar-btn',
      slot: 'topbar:right',
      order: 22,
      render: () => <SnippetsTopBarButton onToggle={toggle} />,
    });

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

    await snippetsClient.load().catch(() => {});
  },
};
