import React from 'react';
import { RotateCcw } from 'lucide-react';
import { type PluginSettingsPageProps, usePluginConfig } from '../../harness';
import {
  DEFAULT_MONITOR_CONFIG,
  MONITOR_PANEL_CATALOG,
  monitorPanelService,
  useMonitorPanelStore,
} from './monitorPanelStore';

export const MonitorSettingsPage: React.FC<PluginSettingsPageProps> = ({ pluginId }) => {
  const { config, updateConfig, resetConfig } = usePluginConfig(
    pluginId,
    DEFAULT_MONITOR_CONFIG,
  );
  const activePanels = useMonitorPanelStore((s) => s.panels);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Sampling Refresh Interval
          </span>
          <select
            aria-label="Monitor Refresh Interval"
            value={config.pollIntervalMs}
            onChange={(e) => void updateConfig({ pollIntervalMs: Number(e.target.value) })}
            className="w-full h-8 px-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value={1000}>1 second (1000ms)</option>
            <option value={2500}>2.5 seconds (2500ms)</option>
            <option value={5000}>5 seconds (5000ms)</option>
            <option value={10000}>10 seconds (10000ms)</option>
          </select>
        </label>

        <label className="block">
          <span className="font-semibold text-[var(--text-primary)] block mb-1">
            Default Process Sort
          </span>
          <select
            aria-label="Default Process Sort"
            value={config.defaultProcessSort}
            onChange={(e) =>
              void updateConfig({
                defaultProcessSort: e.target.value === 'mem' ? 'mem' : 'cpu',
              })
            }
            className="w-full h-8 px-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="cpu">CPU Usage (%)</option>
            <option value="mem">Memory Usage (RSS)</option>
          </select>
        </label>
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
