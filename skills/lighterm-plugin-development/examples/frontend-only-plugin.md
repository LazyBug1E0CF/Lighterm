# Example: Frontend-Only Plugin (`acme.quick-notes`)

A complete frontend-only plugin demonstrating:
- Bottom-docked singleton GUI viewport (`defaultPosition: 'bottom'`, `defaultDockRatio`, `defaultFloatSize`)
- Settings configuration page (`ctx.registerSettingsPage`, `usePluginConfig` with module-level defaults)
- `statusbar:right` toggle button + Command Palette entry + keyboard shortcut with `ctx.onCleanup`
- Sending text into the active terminal via `core:shell` (`shell.sendTextToActiveSession`)

---

## 1. Plugin Implementation (`src/plugins/quick-notes/index.tsx`)

```tsx
import React, { useState } from 'react';
import { RotateCcw, StickyNote } from 'lucide-react';
import {
  definePlugin,
  usePluginConfig,
  type PluginSettingsPageProps,
  type ViewportComponentProps,
} from '../../kernel';

export const QUICK_NOTES_VIEWPORT_TYPE = 'acme.quick-notes.panel';
const LS_NOTES_KEY = 'lighterm:quick-notes-text';

export interface QuickNotesConfig extends Record<string, unknown> {
  fontSizePx: number;
  sendWithNewline: boolean;
}

// Always declare default config at module scope so usePluginConfig keeps a stable reference
export const DEFAULT_QUICK_NOTES_CONFIG: QuickNotesConfig = {
  fontSizePx: 12,
  sendWithNewline: false,
};

function loadInitialNotes(): string {
  try {
    return window.localStorage.getItem(LS_NOTES_KEY) ?? '';
  } catch {
    return '';
  }
}

export const QuickNotesViewport: React.FC<ViewportComponentProps> = () => {
  const { config } = usePluginConfig('acme.quick-notes', DEFAULT_QUICK_NOTES_CONFIG);
  const [text, setText] = useState<string>(loadInitialNotes);

  const handleChange = (next: string) => {
    setText(next);
    try {
      window.localStorage.setItem(LS_NOTES_KEY, next);
    } catch {
      // Ignore quota errors in headless environments
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-surface)] text-[var(--text-primary)] p-2.5 gap-2">
      <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span>Session Scratchpad</span>
        <span>{text.length} chars</span>
      </div>

      <textarea
        data-no-drag="true"
        onPointerDown={(e) => e.stopPropagation()}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Jot down commands or session notes..."
        style={{ fontSize: `${config.fontSizePx}px` }}
        className="flex-1 w-full resize-none rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] p-2 font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
    </div>
  );
};

export const QuickNotesSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(
    pluginId,
    DEFAULT_QUICK_NOTES_CONFIG,
  );

  return (
    <div className="space-y-4">
      <div>
        <label className="block font-semibold text-[var(--text-primary)] mb-1">
          Editor Font Size ({config.fontSizePx}px)
        </label>
        <input
          type="range"
          min={10}
          max={20}
          aria-label="Scratchpad Font Size"
          value={config.fontSizePx}
          onChange={(e) => void updateConfig({ fontSizePx: Number(e.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </div>

      <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
        <input
          type="checkbox"
          aria-label="Execute inserted notes immediately"
          checked={Boolean(config.sendWithNewline)}
          onChange={(e) => void updateConfig({ sendWithNewline: e.target.checked })}
        />
        <span>Append newline when inserting selected command into active shell</span>
      </label>

      <div className="pt-2 border-t border-[var(--border-subtle)] flex justify-end">
        <button
          type="button"
          onClick={() => void resetConfig()}
          className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
        >
          <RotateCcw className="w-3 h-3" />
          Reset Plugin Settings
        </button>
      </div>
    </div>
  );
};

export const quickNotesPlugin = definePlugin({
  id: 'acme.quick-notes',
  name: 'Quick Notes',
  version: '1.0.0',
  description: 'Bottom-docked scratchpad viewport for terminal session notes',
  icon: StickyNote,
  author: 'Acme',
  inject: ['core:shell', 'core:layout'],
  defaultEnabled: true,

  activate(ctx) {
    const shell = ctx.inject('core:shell');
    const layout = ctx.inject('core:layout');

    ctx.registerViewport({
      typeId: QUICK_NOTES_VIEWPORT_TYPE,
      title: 'Quick Notes',
      icon: StickyNote,
      defaultPosition: 'bottom',
      defaultDockRatio: 0.72,
      defaultFloatSize: { width: 560, height: 280 },
      singleton: true,
      openOnStartup: false,
      order: 60,
      component: QuickNotesViewport,
    });

    ctx.registerSettingsPage({
      id: 'quick-notes',
      title: 'Quick Notes',
      description: 'Configure scratchpad font size and terminal insertion behavior.',
      icon: StickyNote,
      order: 60,
      component: QuickNotesSettingsPage,
    });

    const toggle = () => {
      layout.toggleSingletonViewport({ typeId: QUICK_NOTES_VIEWPORT_TYPE });
    };

    ctx.registerSlot({
      id: 'quick-notes-statusbar-btn',
      slot: 'statusbar:right',
      order: 60,
      render: () => (
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1 hover:text-[var(--text-primary)]"
        >
          <StickyNote className="w-3 h-3" /> Notes
        </button>
      ),
    });

    ctx.registerCommand({
      id: 'quick-notes:toggle',
      group: 'Action',
      label: 'Toggle Quick Notes',
      run: toggle,
    });

    ctx.registerCommand({
      id: 'quick-notes:send-first-line',
      group: 'Action',
      label: 'Send First Note Line to Terminal',
      subtitle: 'Quick Notes',
      run: () => {
        const line = loadInitialNotes().split(/\r?\n/)[0]?.trim();
        if (!line) return;
        const cfg = ctx.getConfig(DEFAULT_QUICK_NOTES_CONFIG);
        void shell.sendTextToActiveSession(line, Boolean(cfg.sendWithNewline));
      },
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    ctx.onCleanup(() => window.removeEventListener('keydown', onKeyDown));
  },
});
```

---

## 2. Wire into Plugin Kernel (`src/plugins/index.ts`)

Add the registration inside `registerBuiltinPlugins`:

```ts
import { quickNotesPlugin } from './quick-notes';

export function registerBuiltinPlugins(kernel = pluginKernel): void {
  kernel.provideCoreService('core:shell', shellService);
  kernel.provideCoreService('core:layout', layoutService);

  kernel.register(terminalPlugin);
  kernel.register(hostsPlugin);
  kernel.register(monitorPlugin);
  kernel.register(sftpPlugin);
  kernel.register(snippetsPlugin);
  kernel.register(historyPlugin);
  kernel.register(quickNotesPlugin);
}
```
