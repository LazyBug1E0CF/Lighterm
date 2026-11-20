import React from 'react';
import { Columns2, Layers, LayoutGrid, Plus, Rows2 } from 'lucide-react';
import { shellService } from '../core/shellService';
import { layoutService, useLayoutStore } from './layoutStore';
import type { QuickShellLayoutPreset } from './types';

interface PresetOption {
  id: QuickShellLayoutPreset;
  label: string;
  title: string;
  ariaLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}

const PRESET_OPTIONS: PresetOption[] = [
  {
    id: 'tab',
    label: 'Tab',
    title: 'Stack shells as tabs in one pane',
    ariaLabel: 'Layout Tab',
    icon: Layers,
  },
  {
    id: 'vsp',
    label: 'VSP',
    title: 'Arrange shells vertically side-by-side (equal columns)',
    ariaLabel: 'Layout VSP',
    icon: Columns2,
  },
  {
    id: 'hsp',
    label: 'HSP',
    title: 'Arrange shells horizontally top-to-bottom (equal rows)',
    ariaLabel: 'Layout HSP',
    icon: Rows2,
  },
  {
    id: 'grid',
    label: 'Grid',
    title: 'Arrange shells in an equal 2D grid',
    ariaLabel: 'Layout Grid',
    icon: LayoutGrid,
  },
];

export const NewShellButton: React.FC = () => (
  <button
    type="button"
    data-no-drag="true"
    onClick={(e) => {
      e.stopPropagation();
      void shellService.createLocalSession();
    }}
    title="New Local Terminal (Ctrl+Shift+T)"
    aria-label="New Local Terminal"
    className="h-6 px-2 rounded flex items-center gap-1 shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] border border-transparent hover:border-[var(--border-subtle)] transition-colors"
  >
    <Plus className="w-3.5 h-3.5" />
    <span>Shell</span>
  </button>
);

export const QuickShellLayoutButtons: React.FC = () => {
  const activePreset = useLayoutStore((s) => s.activeLayoutPreset);

  return (
    <div
      role="group"
      aria-label="Quick Shell Layouts"
      className="flex items-center gap-0.5 p-0.5 rounded bg-[var(--bg-app)]/70 border border-[var(--border-subtle)]/70 shrink-0"
    >
      {PRESET_OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = activePreset === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            data-no-drag="true"
            title={opt.title}
            aria-label={opt.ariaLabel}
            aria-pressed={active}
            onClick={(e) => {
              e.stopPropagation();
              layoutService.arrangeWorkspaceShells(opt.id);
            }}
            className={`h-5 px-1.5 rounded flex items-center gap-1 text-[11px] transition-all duration-200 ${
              active
                ? 'bg-[var(--accent)]/20 text-[var(--accent)] font-medium'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
            }`}
          >
            <Icon className="w-3 h-3 shrink-0" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
};
