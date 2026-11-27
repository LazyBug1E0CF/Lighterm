import React from 'react';
import { RotateCcw } from 'lucide-react';
import { CustomSelect, type SelectOption } from '../../components/common/CustomSelect';
import { type PluginSettingsPageProps, usePluginConfig } from '../../kernel';
import {
  DEFAULT_MONITOR_CONFIG,
  MONITOR_PANEL_CATALOG,
  monitorPanelService,
  useMonitorPanelStore,
} from './monitorPanelStore';

const POLL_INTERVAL_OPTIONS: SelectOption[] = [
  { value: '1000', label: '1 second (1000ms)' },
  { value: '2500', label: '2.5 seconds (2500ms)' },
  { value: '5000', label: '5 seconds (5000ms)' },
  { value: '10000', label: '10 seconds (10000ms)' },
];

const PROCESS_SORT_OPTIONS: SelectOption[] = [
  { value: 'cpu', label: 'CPU Usage (%)' },
  { value: 'mem', label: 'Memory Usage (RSS)' },
];

export const MonitorSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(
    pluginId,
    DEFAULT_MONITOR_CONFIG,
  );
  const activePanels = useMonitorPanelStore((s) => s.panels);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Sampling Refresh Interval
          </span>
          <CustomSelect
            ariaLabel="Monitor Refresh Interval"
            value={String(config.pollIntervalMs)}
            options={POLL_INTERVAL_OPTIONS}
            onChange={(val) => void updateConfig({ pollIntervalMs: Number(val) })}
          />
        </div>

        <div>
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Default Process Sort
          </span>
          <CustomSelect
            ariaLabel="Default Process Sort"
            value={config.defaultProcessSort}
            options={PROCESS_SORT_OPTIONS}
            onChange={(val) =>
              void updateConfig({
                defaultProcessSort: val === 'mem' ? 'mem' : 'cpu',
              })
            }
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="font-semibold text-[var(--text-primary)]">Visible Status Cards</span>
          <button
            type="button"
            onClick={() => monitorPanelService.resetPanels()}
            className="h-6 px-2 rounded border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
          >
            <RotateCcw className="w-3 h-3" />
            Reset Default Panels
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {MONITOR_PANEL_CATALOG.map((panel) => {
            const enabled = activePanels.includes(panel.id);
            return (
              <label
                key={panel.id}
                className="p-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/50 flex items-start gap-2 cursor-pointer hover:border-[var(--accent)]/50"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    if (e.target.checked) {
                      monitorPanelService.addPanel(panel.id);
                    } else {
                      monitorPanelService.removePanel(panel.id);
                    }
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block font-medium text-[var(--text-primary)]">
                    {panel.title}
                  </span>
                  <span className="block text-[10px] text-[var(--text-muted)]">
                    {panel.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

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
