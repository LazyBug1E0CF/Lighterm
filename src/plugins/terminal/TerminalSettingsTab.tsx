import React, { useEffect, useMemo } from 'react';
import { Sparkles, Terminal } from 'lucide-react';
import { CustomSelect, type SelectOption } from '../../components/common/CustomSelect';
import { isWebRuntime } from '../../core/ipc';
import {
  getEffectiveLocalShells,
  resolveEffectiveDefaultLocalShell,
  shellService,
  useShellStore,
} from '../../core/shellService';
import { useWebAuthStore } from '../../core/webTransport';

const FONT_PRESETS = [
  "'JetBrains Mono', 'Fira Code', 'Noto Sans Mono CJK SC', monospace",
  "'Fira Code', 'Cascadia Code', 'Noto Sans Mono CJK SC', monospace",
  "'Source Code Pro', 'Ubuntu Mono', monospace",
];

const CURSOR_STYLE_OPTIONS: SelectOption[] = [
  { value: 'bar', label: 'Bar', description: 'Thin vertical line cursor' },
  { value: 'block', label: 'Block', description: 'Solid full-cell cursor' },
  { value: 'underline', label: 'Underline', description: 'Horizontal baseline cursor' },
];

export const TerminalSettingsTab: React.FC = () => {
  const settings = useShellStore((s) => s.settings);
  const localShells = useShellStore((s) => s.localShells);
  const localShellsLoaded = useShellStore((s) => s.localShellsLoaded);
  const webLocalShellEnabled = useWebAuthStore((s) => s.localShellEnabled);
  const localShellAllowed = !isWebRuntime() || webLocalShellEnabled;

  useEffect(() => {
    if (localShellAllowed && !localShellsLoaded) {
      void shellService.listLocalShells();
    }
  }, [localShellAllowed, localShellsLoaded]);

  const availableShells = useMemo(
    () => (localShellAllowed ? getEffectiveLocalShells(localShells) : []),
    [localShellAllowed, localShells],
  );
  const showDefaultLocalShellSetting = localShellAllowed && availableShells.length > 1;
  const autoProfile = availableShells.find((p) => p.isDefault) ?? availableShells[0];
  const activeDefault = resolveEffectiveDefaultLocalShell(settings, availableShells);
  const configuredValue = settings.defaultLocalShell?.trim() ?? '';
  const hasUnavailableConfigured =
    Boolean(configuredValue) && !activeDefault.isAvailableOnSystem;

  const shellOptions = useMemo<SelectOption[]>(() => {
    if (!showDefaultLocalShellSetting) return [];
    const items: SelectOption[] = [
      {
        value: '',
        label: `Auto (${autoProfile ? autoProfile.name : 'System Default'})`,
        description: autoProfile
          ? `${autoProfile.shell} · Automatically selects modern shell`
          : 'System default shell',
        badge: 'Auto',
        icon: <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />,
      },
      ...availableShells.map((profile) => ({
        value: profile.shell,
        label: profile.name,
        description: profile.shell,
        badge: profile.isDefault ? 'Recommended' : undefined,
        icon: <Terminal className="w-3.5 h-3.5 text-[var(--success)]" />,
      })),
    ];
    if (hasUnavailableConfigured) {
      items.push({
        value: configuredValue,
        label: `Unavailable (${configuredValue})`,
        description: 'Not installed on this system',
        badge: 'Unavailable',
        icon: <Terminal className="w-3.5 h-3.5 text-[var(--warning)]" />,
      });
    }
    return items;
  }, [
    showDefaultLocalShellSetting,
    autoProfile,
    availableShells,
    hasUnavailableConfigured,
    configuredValue,
  ]);

  return (
    <div className="space-y-4">
      {showDefaultLocalShellSetting && (
        <div>
          <span className="font-semibold text-[var(--text-primary)] block mb-1.5">
            Default Local Shell
          </span>
          <CustomSelect
            ariaLabel="Default Local Shell"
            value={configuredValue}
            options={shellOptions}
            onChange={(val) =>
              void shellService.updateSettings({
                defaultLocalShell: val ? val : null,
              })
            }
          />
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            {hasUnavailableConfigured ? (
              <>
                Configured shell <span className="font-mono text-[var(--warning)]">{configuredValue}</span> is
                not available on this system — falling back to{' '}
              </>
            ) : (
              <>
                Used when clicking <span className="font-medium text-[var(--text-primary)]">+ Local Shell</span> or pressing{' '}
                <span className="font-mono">{settings.shortcuts.newLocalTab}</span>. Active:{' '}
              </>
            )}
            <span className="font-mono text-[var(--text-primary)]">
              {activeDefault.profile
                ? `${activeDefault.profile.name} (${activeDefault.profile.shell})`
                : activeDefault.shell ?? 'System Default'}
            </span>
          </p>
        </div>
      )}

      <div>
        <label className="block font-semibold text-[var(--text-primary)] mb-1">Font Family</label>
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => void shellService.updateSettings({ fontFamily: e.target.value })}
          className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
        />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {FONT_PRESETS.map((fp) => (
            <button
              key={fp}
              type="button"
              onClick={() => void shellService.updateSettings({ fontFamily: fp })}
              className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              {fp.split(',')[0].replace(/'/g, '')}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Font Size ({settings.fontSize}px)
          </span>
          <input
            type="range"
            min={10}
            max={24}
            step={1}
            value={settings.fontSize}
            onChange={(e) =>
              void shellService.updateSettings({ fontSize: Number(e.target.value) })
            }
            className="w-full accent-[var(--accent)]"
          />
        </label>

        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Line Height ({settings.lineHeight.toFixed(2)})
          </span>
          <input
            type="range"
            min={1.0}
            max={1.8}
            step={0.05}
            value={settings.lineHeight}
            onChange={(e) =>
              void shellService.updateSettings({ lineHeight: Number(e.target.value) })
            }
            className="w-full accent-[var(--accent)]"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="font-semibold text-[var(--text-primary)] block mb-1">Cursor Style</span>
          <CustomSelect
            ariaLabel="Cursor Style"
            value={settings.cursorStyle}
            options={CURSOR_STYLE_OPTIONS}
            onChange={(val) => void shellService.updateSettings({ cursorStyle: val })}
          />
        </div>

        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Scrollback Lines
          </span>
          <input
            type="number"
            min={500}
            max={100000}
            step={500}
            value={settings.scrollback}
            onChange={(e) =>
              void shellService.updateSettings({
                scrollback: Math.max(500, Number(e.target.value) || 5000),
              })
            }
            className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none"
          />
        </label>
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <label className="flex items-center gap-2 text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={settings.cursorBlink}
            onChange={(e) => void shellService.updateSettings({ cursorBlink: e.target.checked })}
          />
          Blink terminal cursor
        </label>
        <label className="flex items-center gap-2 text-[var(--text-primary)]">
          <input
            type="checkbox"
            checked={settings.copyOnSelect}
            onChange={(e) => void shellService.updateSettings({ copyOnSelect: e.target.checked })}
          />
          Automatically copy selected text to clipboard
        </label>
      </div>
    </div>
  );
};
