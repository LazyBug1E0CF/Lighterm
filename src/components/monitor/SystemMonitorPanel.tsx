import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  PanelRightClose,
  Pause,
  Play,
  RefreshCw,
  Server,
  Terminal,
} from 'lucide-react';
import { backend } from '../../services/backend';
import { useAppStore } from '../../store/useAppStore';
import type { SystemStats } from '../../types';

const MAX_SAMPLES = 24;
const POLL_INTERVAL_MS = 2500;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatUptime(secs: number): string {
  if (!secs || secs <= 0) return '0m';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function meterColor(percent: number): string {
  if (percent >= 85) return 'var(--danger)';
  if (percent >= 65) return 'var(--warning)';
  return 'var(--accent)';
}

interface SparklineProps {
  values: number[];
  maxVal?: number;
  strokeColor: string;
  secondaryValues?: number[];
  secondaryColor?: string;
}

const Sparkline: React.FC<SparklineProps> = ({
  values,
  maxVal,
  strokeColor,
  secondaryValues,
  secondaryColor,
}) => {
  const width = 240;
  const height = 34;

  const computedMax = useMemo(() => {
    if (maxVal && maxVal > 0) return maxVal;
    const all = [...values, ...(secondaryValues ?? [])];
    const peak = Math.max(1024, ...all);
    return peak * 1.15;
  }, [values, secondaryValues, maxVal]);

  const toPolyline = (series: number[]) => {
    if (series.length === 0) return '';
    if (series.length === 1) {
      const y = height - Math.min(1, Math.max(0, series[0] / computedMax)) * (height - 4) - 2;
      return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
    }
    return series
      .map((val, i) => {
        const x = (i / (MAX_SAMPLES - 1)) * width + ((MAX_SAMPLES - series.length) / (MAX_SAMPLES - 1)) * width;
        const clamped = Math.min(1, Math.max(0, val / computedMax));
        const y = height - clamped * (height - 4) - 2;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  const primaryPoints = toPolyline(values);
  const secondaryPoints = secondaryValues ? toPolyline(secondaryValues) : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full h-8 overflow-visible"
      preserveAspectRatio="none"
    >
      {primaryPoints && (
        <polyline
          fill="none"
          stroke={strokeColor}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={primaryPoints}
        />
      )}
      {secondaryPoints && secondaryColor && (
        <polyline
          fill="none"
          stroke={secondaryColor}
          strokeWidth="1.5"
          strokeDasharray="3 2"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={secondaryPoints}
        />
      )}
    </svg>
  );
};

export const SystemMonitorPanel: React.FC = () => {
  const monitorOpen = useAppStore((s) => s.monitorOpen);
  const toggleMonitorPanel = useAppStore((s) => s.toggleMonitorPanel);
  const hosts = useAppStore((s) => s.hosts);
  const activePane = useAppStore((s) => s.getActivePane());

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [rxHistory, setRxHistory] = useState<number[]>([]);
  const [txHistory, setTxHistory] = useState<number[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [procSort, setProcSort] = useState<'cpu' | 'mem'>('cpu');

  const inFlightRef = useRef(false);

  const activeHostConfig = useMemo(() => {
    if (!activePane || activePane.kind !== 'ssh') return undefined;
    if (activePane.hostId) {
      return hosts.find((h) => h.id === activePane.hostId) ?? activePane.hostConfig;
    }
    return activePane.hostConfig;
  }, [activePane, hosts]);

  const targetKey = useMemo(() => {
    if (!activePane) return 'local';
    if (activePane.kind === 'ssh') {
      return `ssh:${activePane.hostId ?? activeHostConfig?.host ?? activePane.sessionId}`;
    }
    return 'local';
  }, [activePane, activeHostConfig]);

  const fetchStats = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const kind = activePane?.kind ?? 'local';
      const data = await backend.getSystemStats({
        kind,
        hostId: activePane?.hostId,
        hostConfig: activeHostConfig,
      });
      setStats(data);
      setError(null);
      setCpuHistory((prev) => [...prev.slice(-(MAX_SAMPLES - 1)), data.cpuUsagePercent]);
      setRxHistory((prev) => [...prev.slice(-(MAX_SAMPLES - 1)), data.netRxBytesPerSec]);
      setTxHistory((prev) => [...prev.slice(-(MAX_SAMPLES - 1)), data.netTxBytesPerSec]);
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      setError(msg);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [activePane?.kind, activePane?.hostId, activeHostConfig]);

  useEffect(() => {
    setCpuHistory([]);
    setRxHistory([]);
    setTxHistory([]);
    setStats(null);
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    if (!monitorOpen || paused) return;
    void fetchStats();
    const timer = window.setInterval(() => {
      void fetchStats();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [monitorOpen, paused, targetKey, fetchStats]);

  const sortedProcesses = useMemo(() => {
    if (!stats) return [];
    const copy = [...stats.topProcesses];
    copy.sort((a, b) =>
      procSort === 'cpu'
        ? b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes
        : b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent,
    );
    return copy;
  }, [stats, procSort]);

  if (!monitorOpen) return null;

  const memPercent =
    stats && stats.memTotalBytes > 0
      ? (stats.memUsedBytes / stats.memTotalBytes) * 100
      : 0;
  const swapPercent =
    stats && stats.swapTotalBytes > 0
      ? (stats.swapUsedBytes / stats.swapTotalBytes) * 100
      : 0;

  return (
    <aside
      aria-label="System Status Panel"
      className="w-72 shrink-0 h-full flex flex-col border-l select-none text-xs"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Panel Header */}
      <div className="h-9 px-3 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Activity className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] truncate">
            System Status
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            title={paused ? 'Resume Auto Refresh' : 'Pause Auto Refresh'}
            aria-label={paused ? 'Resume Monitor' : 'Pause Monitor'}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void fetchStats()}
            title="Refresh Now"
            aria-label="Refresh System Status"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={toggleMonitorPanel}
            title="Collapse System Status Panel (Ctrl+Shift+M)"
            aria-label="Close System Status Panel"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto lighterm-scroll p-2.5 space-y-3">
        {error && (
          <div className="p-2 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[11px] text-[var(--danger)] break-words">
            {error}
          </div>
        )}

        {!stats && !error ? (
          <div className="py-10 text-center text-[var(--text-muted)]">Collecting metrics...</div>
        ) : stats ? (
          <>
            {/* Host Overview */}
            <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  {stats.source === 'ssh' ? (
                    <Server className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  ) : (
                    <Terminal className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
                  )}
                  <span className="font-semibold text-[var(--text-primary)] truncate">
                    {stats.hostname}
                  </span>
                </div>
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0"
                  style={{
                    backgroundColor:
                      stats.source === 'ssh'
                        ? 'rgba(122, 162, 247, 0.18)'
                        : 'rgba(158, 206, 106, 0.18)',
                    color: stats.source === 'ssh' ? 'var(--accent)' : 'var(--success)',
                  }}
                >
                  {stats.source}
                </span>
              </div>

              <div className="text-[11px] text-[var(--text-muted)] truncate">
                {stats.osName} {stats.arch ? `· ${stats.arch}` : ''}
              </div>
              {stats.kernelVersion && (
                <div className="text-[10px] font-mono text-[var(--text-muted)] truncate">
                  {stats.kernelVersion}
                </div>
              )}

              <div className="pt-1 flex items-center justify-between text-[11px] border-t border-[var(--border-subtle)]/50">
                <span className="text-[var(--text-muted)]">
                  Up <strong className="text-[var(--text-primary)]">{formatUptime(stats.uptimeSecs)}</strong>
                </span>
                <span className="font-mono text-[10px] text-[var(--text-muted)]">
                  Load {stats.loadAvg.map((v) => v.toFixed(2)).join(' ')}
                </span>
              </div>
            </div>

            {/* CPU */}
            <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[var(--text-primary)] font-medium">
                  <Cpu className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>CPU</span>
                  <span className="text-[10px] text-[var(--text-muted)]">({stats.cpuCores}c)</span>
                </div>
                <span
                  className="font-mono font-semibold"
                  style={{ color: meterColor(stats.cpuUsagePercent) }}
                >
                  {stats.cpuUsagePercent.toFixed(1)}%
                </span>
              </div>

              <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                <div
                  className="h-full transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(0, stats.cpuUsagePercent))}%`,
                    backgroundColor: meterColor(stats.cpuUsagePercent),
                  }}
                />
              </div>

              <Sparkline values={cpuHistory} maxVal={100} strokeColor="var(--accent)" />
            </div>

            {/* Memory & Swap */}
            <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-2">
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[var(--text-primary)] font-medium">
                    <MemoryStick className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span>Memory</span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--text-primary)]">
                    {memPercent.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                  <div
                    className="h-full transition-all duration-300"
                    style={{
                      width: `${Math.min(100, Math.max(0, memPercent))}%`,
                      backgroundColor: meterColor(memPercent),
                    }}
                  />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-[var(--text-muted)]">
                  <span>{formatBytes(stats.memUsedBytes)} used</span>
                  <span>{formatBytes(stats.memTotalBytes)} total</span>
                </div>
              </div>

              {stats.swapTotalBytes > 0 && (
                <div className="pt-1.5 border-t border-[var(--border-subtle)]/40 space-y-1">
                  <div className="flex justify-between text-[10px] text-[var(--text-muted)]">
                    <span>Swap</span>
                    <span className="font-mono">
                      {formatBytes(stats.swapUsedBytes)} / {formatBytes(stats.swapTotalBytes)}
                    </span>
                  </div>
                  <div className="h-1 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--warning)] transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(0, swapPercent))}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Network */}
            <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[var(--text-primary)] font-medium">
                  <Network className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>Network</span>
                </div>
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="flex items-center gap-0.5 text-[var(--success)]">
                    <ArrowDown className="w-2.5 h-2.5" />
                    {formatBytes(stats.netRxBytesPerSec)}/s
                  </span>
                  <span className="flex items-center gap-0.5 text-[var(--warning)]">
                    <ArrowUp className="w-2.5 h-2.5" />
                    {formatBytes(stats.netTxBytesPerSec)}/s
                  </span>
                </div>
              </div>

              <Sparkline
                values={rxHistory}
                secondaryValues={txHistory}
                strokeColor="var(--success)"
                secondaryColor="var(--warning)"
              />

              <div className="flex justify-between text-[10px] font-mono text-[var(--text-muted)]">
                <span>Total ↓ {formatBytes(stats.netTotalRxBytes)}</span>
                <span>Total ↑ {formatBytes(stats.netTotalTxBytes)}</span>
              </div>
            </div>

            {/* Disks */}
            {stats.disks.length > 0 && (
              <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-2">
                <div className="flex items-center gap-1.5 text-[var(--text-primary)] font-medium">
                  <HardDrive className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>Disks</span>
                </div>
                <div className="space-y-2">
                  {stats.disks.map((d) => (
                    <div key={d.mountPoint} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="font-mono text-[var(--text-primary)] truncate max-w-[140px]">
                          {d.mountPoint}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--text-muted)]">
                          {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)}
                        </span>
                      </div>
                      <div className="h-1 w-full rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div
                          className="h-full transition-all"
                          style={{
                            width: `${Math.min(100, Math.max(0, d.usagePercent))}%`,
                            backgroundColor: meterColor(d.usagePercent),
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top Processes */}
            {sortedProcesses.length > 0 && (
              <div className="p-2.5 rounded-lg border border-[var(--border-subtle)]/70 bg-[var(--bg-app)]/50 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--text-primary)] font-medium">Top Processes</span>
                  <div className="flex items-center gap-1 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setProcSort('cpu')}
                      className={`px-1.5 py-0.5 rounded ${
                        procSort === 'cpu'
                          ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      CPU
                    </button>
                    <button
                      type="button"
                      onClick={() => setProcSort('mem')}
                      className={`px-1.5 py-0.5 rounded ${
                        procSort === 'mem'
                          ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      MEM
                    </button>
                  </div>
                </div>

                <div className="divide-y divide-[var(--border-subtle)]/40 text-[11px]">
                  {sortedProcesses.map((proc) => (
                    <div
                      key={proc.pid}
                      className="py-1 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[var(--text-primary)]">{proc.name}</div>
                        <div className="text-[10px] font-mono text-[var(--text-muted)]">
                          PID {proc.pid}
                        </div>
                      </div>
                      <div className="text-right font-mono shrink-0">
                        <div className="text-[var(--accent)]">{proc.cpuPercent.toFixed(1)}%</div>
                        <div className="text-[10px] text-[var(--text-muted)]">
                          {formatBytes(proc.memoryBytes)}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
};
