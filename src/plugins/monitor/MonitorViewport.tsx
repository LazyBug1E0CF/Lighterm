import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Cpu,
  ExternalLink,
  HardDrive,
  ListOrdered,
  MemoryStick,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Terminal,
  X,
} from 'lucide-react';
import { useShellStore } from '../../core/shellService';
import { usePluginConfig } from '../../harness';
import { harnessKernel } from '../../harness/HarnessKernel';
import type { ViewportComponentProps } from '../../harness/types';
import { layoutService } from '../../layout/layoutStore';
import type { SystemStats } from '../../types';
import { fetchSystemStats } from './monitorClient';
import {
  computeCardDisplacementY,
  computeDragTargetIndex,
  measurePanelGap,
  type PanelBaseRect,
} from './monitorDragLayout';
import {
  DEFAULT_MONITOR_CONFIG,
  DEFAULT_MONITOR_PANELS,
  getMonitorPanelViewportType,
  isDefaultPanelOrder,
  MONITOR_PANEL_CATALOG,
  MONITOR_PANEL_META_MAP,
  monitorPanelService,
  useMonitorPanelStore,
  type MonitorPanelId,
} from './monitorPanelStore';

const MAX_SAMPLES = 24;
const POLL_INTERVAL_MS = 2500;
const DRAG_THRESHOLD_PX = 5;
const AUTOSCROLL_EDGE_PX = 36;
const AUTOSCROLL_MAX_STEP_PX = 10;
const PANEL_TRANSITION = 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface PanelDragState {
  panelId: MonitorPanelId;
  fromIndex: number;
  targetIndex: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  offsetX: number;
  offsetY: number;
  draggedWidth: number;
  draggedHeight: number;
  startScrollTop: number;
  gap: number;
  baseRects: PanelBaseRect[];
  active: boolean;
  tornOff?: boolean;
}

export const PANEL_ICON_MAP: Record<MonitorPanelId, React.ComponentType<{ className?: string }>> = {
  host: Server,
  cpu: Cpu,
  memory: MemoryStick,
  network: Network,
  disks: HardDrive,
  processes: ListOrdered,
};

const PANEL_ICON_COLOR_MAP: Record<MonitorPanelId, string> = {
  host: 'text-[var(--accent)]',
  cpu: 'text-[var(--accent)]',
  memory: 'text-[var(--success)]',
  network: 'text-[var(--accent)]',
  disks: 'text-[var(--accent)]',
  processes: 'text-[var(--accent)]',
};

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
        const x =
          (i / (MAX_SAMPLES - 1)) * width +
          ((MAX_SAMPLES - series.length) / (MAX_SAMPLES - 1)) * width;
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

interface StatusPanelCardProps {
  panelId: MonitorPanelId;
  title: string;
  icon: React.ReactNode;
  headerMeta?: React.ReactNode;
  headerRight?: React.ReactNode;
  isGhost?: boolean;
  isPlaceholder?: boolean;
  placeholderHeight?: number;
  isDragActive?: boolean;
  displacementY?: number;
  animateDisplacement?: boolean;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onKeyboardReorder: (delta: -1 | 1) => void;
  onDetach?: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}

const StatusPanelCard: React.FC<StatusPanelCardProps> = ({
  panelId,
  title,
  icon,
  headerMeta,
  headerRight,
  isGhost = false,
  isPlaceholder = false,
  placeholderHeight = 0,
  isDragActive = false,
  displacementY = 0,
  animateDisplacement = false,
  onHeaderPointerDown,
  onKeyboardReorder,
  onDetach,
  onRemove,
  children,
}) => {
  if (isGhost) {
    return (
      <div className="p-2.5 rounded-lg border border-[var(--accent)]/60 bg-[var(--bg-app)]/70 space-y-1.5">
        <div className="flex items-center justify-between gap-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            {icon}
            <span className="font-medium text-[var(--text-primary)] truncate">{title}</span>
            {headerMeta}
          </div>
          {headerRight && (
            <div className="flex items-center gap-1.5 shrink-0">{headerRight}</div>
          )}
        </div>
        {children}
      </div>
    );
  }

  const dragStyle: React.CSSProperties | undefined = isDragActive
    ? {
        ...(isPlaceholder && placeholderHeight > 0 ? { height: placeholderHeight } : {}),
        transform: `translate3d(0, ${displacementY}px, 0)`,
        transition: animateDisplacement ? PANEL_TRANSITION : undefined,
        willChange: animateDisplacement ? 'transform' : undefined,
      }
    : undefined;

  if (isPlaceholder) {
    return (
      <section
        data-monitor-panel-id={panelId}
        data-panel-placeholder="true"
        aria-label={`${title} Status Panel`}
        style={dragStyle}
        className="relative rounded-lg border border-dashed border-[var(--accent)]/55 bg-[var(--accent)]/[0.06] pointer-events-none"
      />
    );
  }

  return (
    <section
      data-monitor-panel-id={panelId}
      data-panel-displaced={animateDisplacement && displacementY !== 0 ? 'true' : 'false'}
      aria-label={`${title} Status Panel`}
      style={dragStyle}
      className="relative group p-2.5 rounded-lg border border-[var(--border-subtle)]/70 hover:border-[var(--border-subtle)] bg-[var(--bg-app)]/50 space-y-1.5 transition-colors"
    >
      <div
        onPointerDown={onHeaderPointerDown}
        className="flex items-center justify-between gap-1.5 cursor-grab active:cursor-grabbing"
      >
        <div
          role="button"
          tabIndex={0}
          aria-label={`Drag to reorder ${title} Panel`}
          title="Drag to reorder or drag outside to open as independent viewport (or use Up/Down arrows)"
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onKeyboardReorder(-1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onKeyboardReorder(1);
            }
          }}
          className="flex items-center gap-1.5 min-w-0 rounded focus:outline-none focus:text-[var(--accent)]"
        >
          {icon}
          <span className="font-medium text-[var(--text-primary)] truncate">{title}</span>
          {headerMeta}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {headerRight}
          {onDetach && (
            <button
              type="button"
              data-no-panel-drag="true"
              onClick={onDetach}
              title={`Open ${title} as Independent Viewport`}
              aria-label={`Detach ${title} as Viewport`}
              className="hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--accent)] hover:bg-[var(--bg-elevated)]"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            data-no-panel-drag="true"
            onClick={onRemove}
            title={`Remove ${title} Panel`}
            aria-label={`Remove ${title} Panel`}
            className="hidden group-hover:inline-flex focus-visible:inline-flex items-center justify-center p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--danger)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {children}
    </section>
  );
};

function useMonitorTelemetry(paused: boolean, enabled: boolean) {
  const hosts = useShellStore((s) => s.hosts);
  const activeSessionId = useShellStore((s) => s.activeSessionId);
  const activeSession = useShellStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : undefined,
  );
  const { config: monitorConfig } = usePluginConfig(
    'lighterm.monitor',
    DEFAULT_MONITOR_CONFIG,
  );

  const [stats, setStats] = useState<SystemStats | null>(null);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [rxHistory, setRxHistory] = useState<number[]>([]);
  const [txHistory, setTxHistory] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [procSort, setProcSort] = useState<'cpu' | 'mem'>(monitorConfig.defaultProcessSort);

  const inFlightRef = useRef(false);

  const activeHostConfig = useMemo(() => {
    if (!activeSession || activeSession.info.kind !== 'ssh') return undefined;
    if (activeSession.hostId) {
      return hosts.find((h) => h.id === activeSession.hostId) ?? activeSession.hostConfig;
    }
    return activeSession.hostConfig;
  }, [activeSession, hosts]);

  const targetKey = useMemo(() => {
    if (!activeSession) return 'local';
    if (activeSession.info.kind === 'ssh') {
      return `ssh:${activeSession.hostId ?? activeHostConfig?.host ?? activeSession.info.id}`;
    }
    return 'local';
  }, [activeSession, activeHostConfig]);

  const fetchStats = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const kind = activeSession?.info.kind ?? 'local';
      const data = await fetchSystemStats({
        kind,
        hostId: activeSession?.hostId,
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
  }, [activeSession?.info.kind, activeSession?.hostId, activeHostConfig]);

  useEffect(() => {
    setCpuHistory([]);
    setRxHistory([]);
    setTxHistory([]);
    setStats(null);
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    setProcSort(monitorConfig.defaultProcessSort);
  }, [monitorConfig.defaultProcessSort]);

  useEffect(() => {
    if (paused || !enabled) return;
    const pollMs = Math.max(500, Number(monitorConfig.pollIntervalMs) || POLL_INTERVAL_MS);
    void fetchStats();
    const timer = window.setInterval(() => {
      void fetchStats();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [paused, enabled, targetKey, fetchStats, monitorConfig.pollIntervalMs]);

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

  const memPercent =
    stats && stats.memTotalBytes > 0 ? (stats.memUsedBytes / stats.memTotalBytes) * 100 : 0;
  const swapPercent =
    stats && stats.swapTotalBytes > 0 ? (stats.swapUsedBytes / stats.swapTotalBytes) * 100 : 0;

  return {
    stats,
    cpuHistory,
    rxHistory,
    txHistory,
    loading,
    error,
    targetKey,
    activeHostConfig,
    fetchStats,
    procSort,
    setProcSort,
    sortedProcesses,
    memPercent,
    swapPercent,
  };
}

type TelemetryState = ReturnType<typeof useMonitorTelemetry>;

function getPanelHeaderExtras(
  panelId: MonitorPanelId,
  telemetry: TelemetryState,
): {
  icon: React.ReactNode;
  headerMeta?: React.ReactNode;
  headerRight?: React.ReactNode;
} {
  const { stats, memPercent, procSort, setProcSort } = telemetry;
  if (!stats) {
    const FallbackIcon = PANEL_ICON_MAP[panelId];
    return { icon: <FallbackIcon className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" /> };
  }

  switch (panelId) {
    case 'host':
      return {
        icon:
          stats.source === 'ssh' ? (
            <Server className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
          ) : (
            <Terminal className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />
          ),
        headerRight: (
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
        ),
      };
    case 'cpu':
      return {
        icon: <Cpu className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />,
        headerMeta: (
          <span className="text-[10px] text-[var(--text-muted)] shrink-0">
            ({stats.cpuCores}c)
          </span>
        ),
        headerRight: (
          <span
            className="font-mono font-semibold"
            style={{ color: meterColor(stats.cpuUsagePercent) }}
          >
            {stats.cpuUsagePercent.toFixed(1)}%
          </span>
        ),
      };
    case 'memory':
      return {
        icon: <MemoryStick className="w-3.5 h-3.5 text-[var(--success)] shrink-0" />,
        headerRight: (
          <span className="font-mono text-[11px] text-[var(--text-primary)]">
            {memPercent.toFixed(1)}%
          </span>
        ),
      };
    case 'network':
      return { icon: <Network className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" /> };
    case 'disks':
      return { icon: <HardDrive className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" /> };
    case 'processes':
      return {
        icon: <ListOrdered className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />,
        headerRight: (
          <div className="flex items-center gap-1 text-[10px]">
            <button
              type="button"
              data-no-panel-drag="true"
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
              data-no-panel-drag="true"
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
        ),
      };
  }
}

function renderPanelBodyContent(panelId: MonitorPanelId, telemetry: TelemetryState): React.ReactNode {
  const { stats, cpuHistory, rxHistory, txHistory, sortedProcesses, memPercent, swapPercent } =
    telemetry;
  if (!stats) return null;

  switch (panelId) {
    case 'host':
      return (
        <>
          <div className="font-semibold text-[var(--text-primary)] truncate">{stats.hostname}</div>
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
              Up{' '}
              <strong className="text-[var(--text-primary)]">
                {formatUptime(stats.uptimeSecs)}
              </strong>
            </span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              Load {stats.loadAvg.map((v) => v.toFixed(2)).join(' ')}
            </span>
          </div>
        </>
      );

    case 'cpu':
      return (
        <>
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
        </>
      );

    case 'memory':
      return (
        <>
          <div className="space-y-1">
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
        </>
      );

    case 'network':
      return (
        <>
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="flex items-center gap-0.5 text-[var(--success)]">
              <ArrowDown className="w-2.5 h-2.5" />
              {formatBytes(stats.netRxBytesPerSec)}/s
            </span>
            <span className="flex items-center gap-0.5 text-[var(--warning)]">
              <ArrowUp className="w-2.5 h-2.5" />
              {formatBytes(stats.netTxBytesPerSec)}/s
            </span>
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
        </>
      );

    case 'disks':
      return stats.disks.length > 0 ? (
        <div className="space-y-2 pt-0.5">
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
      ) : (
        <div className="text-[11px] text-[var(--text-muted)]">No mounted disks detected</div>
      );

    case 'processes':
      return sortedProcesses.length > 0 ? (
        <div className="divide-y divide-[var(--border-subtle)]/40 text-[11px]">
          {sortedProcesses.map((proc) => (
            <div key={proc.pid} className="py-1 flex items-center justify-between gap-2">
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
      ) : (
        <div className="text-[11px] text-[var(--text-muted)]">No process data available</div>
      );
  }
}

export const MonitorSinglePanelViewport: React.FC<
  ViewportComponentProps & { panelId: MonitorPanelId }
> = ({ panelId, onClose }) => {
  const [paused, setPaused] = useState(false);
  const telemetry = useMonitorTelemetry(paused, true);
  const meta = MONITOR_PANEL_META_MAP[panelId];
  const extras = getPanelHeaderExtras(panelId, telemetry);

  const handleReturnToMonitor = () => {
    monitorPanelService.addPanel(panelId);
    onClose();
  };

  return (
    <section
      aria-label={`${meta.title} Viewport`}
      data-monitor-standalone-panel={panelId}
      className="flex-1 flex flex-col min-w-0 min-h-0 select-none text-xs"
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      <div className="h-8 px-2.5 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {extras.icon}
          <span className="text-[11px] font-medium text-[var(--text-muted)] truncate">
            {telemetry.targetKey === 'local'
              ? 'Local'
              : telemetry.activeHostConfig?.host ?? 'SSH'}
          </span>
          {extras.headerMeta}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {extras.headerRight}
          <button
            type="button"
            onClick={handleReturnToMonitor}
            title={`Return ${meta.title} to System Status`}
            aria-label={`Return ${meta.title} to System Status`}
            className="px-1.5 py-0.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
          >
            <ArrowLeft className="w-2.5 h-2.5" />
            <span>Merge</span>
          </button>
          <button
            type="button"
            onClick={() => setPaused((v) => !v)}
            title={paused ? 'Resume Auto Refresh' : 'Pause Auto Refresh'}
            aria-label={paused ? `Resume ${meta.title}` : `Pause ${meta.title}`}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void telemetry.fetchStats()}
            title="Refresh Now"
            aria-label={`Refresh ${meta.title}`}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${telemetry.loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto lighterm-scroll p-2.5 space-y-2">
        {telemetry.error && (
          <div className="p-2 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[11px] text-[var(--danger)] break-words">
            {telemetry.error}
          </div>
        )}

        {!telemetry.stats && !telemetry.error ? (
          <div className="py-10 text-center text-[var(--text-muted)]">Collecting metrics...</div>
        ) : telemetry.stats ? (
          renderPanelBodyContent(panelId, telemetry)
        ) : null}
      </div>
    </section>
  );
};

export function createMonitorSinglePanelViewport(
  panelId: MonitorPanelId,
): React.FC<ViewportComponentProps> {
  const Component: React.FC<ViewportComponentProps> = (props) => (
    <MonitorSinglePanelViewport {...props} panelId={panelId} />
  );
  Component.displayName = `MonitorSinglePanelViewport(${panelId})`;
  return Component;
}

export const MonitorViewport: React.FC<ViewportComponentProps> = ({ viewport }) => {
  const panels = useMonitorPanelStore((s) => s.panels);
  const [paused, setPaused] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [panelDrag, setPanelDrag] = useState<PanelDragState | null>(null);
  const [flipSeq, setFlipSeq] = useState(0);

  const hasPanels = panels.length > 0;
  const telemetry = useMonitorTelemetry(paused, hasPanels);
  const { stats, loading, error, targetKey, activeHostConfig, fetchStats } = telemetry;

  const asideRef = useRef<HTMLElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const panelDragRef = useRef<PanelDragState | null>(null);
  const flipPrevRectsRef = useRef<Map<string, { left: number; top: number; fromGhost?: boolean }>>(
    new Map(),
  );

  const missingPanels = useMemo(
    () => DEFAULT_MONITOR_PANELS.filter((id) => !panels.includes(id)),
    [panels],
  );
  const isDefaultLayout = useMemo(() => isDefaultPanelOrder(panels), [panels]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAddMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [addMenuOpen]);

  const capturePanelRects = useCallback((ghostPanelId?: MonitorPanelId) => {
    const map = new Map<string, { left: number; top: number; fromGhost?: boolean }>();
    const container = bodyScrollRef.current;
    if (!container) return;
    const cards = container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]');
    for (const el of cards) {
      const id = el.dataset.monitorPanelId;
      if (!id) continue;
      const rect = el.getBoundingClientRect();
      map.set(id, { left: rect.left, top: rect.top });
    }
    if (ghostPanelId && asideRef.current) {
      const ghostEl = asideRef.current.querySelector<HTMLElement>(
        `[data-monitor-drag-ghost="${ghostPanelId}"]`,
      );
      if (ghostEl) {
        const ghostRect = ghostEl.getBoundingClientRect();
        map.set(ghostPanelId, { left: ghostRect.left, top: ghostRect.top, fromGhost: true });
      }
    }
    flipPrevRectsRef.current = map;
  }, []);

  useLayoutEffect(() => {
    const prevRects = flipPrevRectsRef.current;
    if (prevRects.size === 0) return;
    flipPrevRectsRef.current = new Map();

    if (prefersReducedMotion()) return;

    const container = bodyScrollRef.current;
    if (!container) return;
    const cards = container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]');
    for (const el of cards) {
      const id = el.dataset.monitorPanelId;
      if (!id || typeof el.animate !== 'function') continue;
      const prev = prevRects.get(id);
      if (!prev) continue;
      const next = el.getBoundingClientRect();
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (prev.fromGhost) {
        el.animate(
          [
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale(1.02)`, opacity: 0.72 },
            { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
          ],
          { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      } else if (Math.abs(dy) >= 1) {
        el.animate(
          [
            { transform: `translate3d(0, ${dy}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      }
    }
  }, [panels, flipSeq]);

  const resolveTargetIndex = useCallback((cur: PanelDragState, clientY: number): number => {
    const scrollDelta = (bodyScrollRef.current?.scrollTop ?? 0) - cur.startScrollTop;
    const ghostCenterLogicalY = clientY - cur.offsetY + cur.draggedHeight / 2 + scrollDelta;
    return computeDragTargetIndex(cur.baseRects, cur.fromIndex, ghostCenterLogicalY, cur.gap);
  }, []);

  const isOutsideMonitorBounds = useCallback(
    (panelId: MonitorPanelId, clientX: number, clientY: number): boolean => {
      const vpType = getMonitorPanelViewportType(panelId);
      if (!harnessKernel.getViewportDescriptor(vpType)) return false;
      const asideEl = asideRef.current;
      if (!asideEl) return false;
      const rect = asideEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      return (
        clientX < rect.left - 16 ||
        clientX > rect.right + 6 ||
        clientY < rect.top - 8 ||
        clientY > rect.bottom + 16
      );
    },
    [],
  );

  const isTrackingDrag = Boolean(panelDrag);
  const isDragActive = Boolean(panelDrag?.active && !panelDrag.tornOff);

  useEffect(() => {
    if (!isTrackingDrag) return;

    const clearDrag = () => {
      panelDragRef.current = null;
      setPanelDrag(null);
    };

    const onMove = (ev: PointerEvent) => {
      const cur = panelDragRef.current;
      if (!cur) return;
      const dist = Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY);
      const active = cur.active || dist >= DRAG_THRESHOLD_PX;
      const outside = active && isOutsideMonitorBounds(cur.panelId, ev.clientX, ev.clientY);

      if (outside) {
        const next: PanelDragState = {
          ...cur,
          currentX: ev.clientX,
          currentY: ev.clientY,
          active: true,
          tornOff: true,
        };
        panelDragRef.current = next;
        if (!cur.tornOff) {
          setPanelDrag(next);
          const meta = MONITOR_PANEL_META_MAP[cur.panelId];
          const floatOffsetX = Math.min(180, Math.max(24, Math.round(cur.offsetX)));
          layoutService.startTearOffDrag({
            typeId: meta.viewportTypeId,
            pluginId: 'lighterm.monitor',
            title: meta.title,
            params: { panelId: cur.panelId },
            dockRatio: meta.defaultDockRatio,
            floatRect: meta.defaultFloatSize,
            originViewportId: viewport.id,
            startX: cur.startX,
            startY: cur.startY,
            currentX: ev.clientX,
            currentY: ev.clientY,
            floatOffsetX,
            floatOffsetY: 16,
            active: true,
            onCommit: () => {
              monitorPanelService.removePanel(cur.panelId);
            },
          });
        }
        return;
      }

      if (cur.tornOff) {
        layoutService.cancelDrag();
      }

      const targetIndex = active ? resolveTargetIndex(cur, ev.clientY) : cur.targetIndex;
      const next: PanelDragState = {
        ...cur,
        currentX: ev.clientX,
        currentY: ev.clientY,
        active,
        tornOff: false,
        targetIndex,
      };
      panelDragRef.current = next;
      setPanelDrag(next);
    };

    const onUp = () => {
      const cur = panelDragRef.current;
      if (cur?.tornOff) {
        clearDrag();
        return;
      }
      if (cur?.active) {
        capturePanelRects(cur.panelId);
      }
      clearDrag();
      if (!cur || !cur.active) return;
      if (cur.targetIndex !== cur.fromIndex) {
        monitorPanelService.movePanelToIndex(cur.panelId, cur.targetIndex);
      }
      setFlipSeq((s) => s + 1);
    };

    const onCancel = () => {
      const cur = panelDragRef.current;
      if (cur?.tornOff) {
        layoutService.cancelDrag();
      } else if (cur?.active) {
        capturePanelRects(cur.panelId);
        setFlipSeq((s) => s + 1);
      }
      clearDrag();
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        onCancel();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isTrackingDrag, resolveTargetIndex, capturePanelRects, isOutsideMonitorBounds, viewport.id]);

  useEffect(() => {
    if (!isDragActive || typeof requestAnimationFrame !== 'function') return;
    let rafId = 0;

    const tick = () => {
      const cur = panelDragRef.current;
      const el = bodyScrollRef.current;
      if (!cur || !cur.active || !el) return;

      const rect = el.getBoundingClientRect();
      if (rect.height > 0) {
        let delta = 0;
        if (cur.currentY < rect.top + AUTOSCROLL_EDGE_PX && el.scrollTop > 0) {
          const ratio = (rect.top + AUTOSCROLL_EDGE_PX - cur.currentY) / AUTOSCROLL_EDGE_PX;
          delta = -Math.max(2, Math.round(Math.min(1, ratio) * AUTOSCROLL_MAX_STEP_PX));
        } else if (
          cur.currentY > rect.bottom - AUTOSCROLL_EDGE_PX &&
          el.scrollTop + el.clientHeight < el.scrollHeight
        ) {
          const ratio = (cur.currentY - (rect.bottom - AUTOSCROLL_EDGE_PX)) / AUTOSCROLL_EDGE_PX;
          delta = Math.max(2, Math.round(Math.min(1, ratio) * AUTOSCROLL_MAX_STEP_PX));
        }
        if (delta !== 0) {
          el.scrollTop += delta;
          const nextTarget = resolveTargetIndex(cur, cur.currentY);
          if (nextTarget !== cur.targetIndex) {
            const updated: PanelDragState = { ...cur, targetIndex: nextTarget };
            panelDragRef.current = updated;
            setPanelDrag(updated);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isDragActive, resolveTargetIndex]);

  const startPanelDrag = (
    e: React.PointerEvent,
    panelId: MonitorPanelId,
    fromIndex: number,
  ) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-no-panel-drag="true"], button, input, a')) return;
    // Stop propagation so dragging an internal status card never starts outer viewport drag
    e.preventDefault();
    e.stopPropagation();

    const cardEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-monitor-panel-id]');
    const cardRect = cardEl?.getBoundingClientRect();
    const container = bodyScrollRef.current;
    const cards = container
      ? Array.from(container.querySelectorAll<HTMLElement>('[data-monitor-panel-id]'))
      : [];
    const baseRects: PanelBaseRect[] = cards
      .map((el) => {
        const id = el.dataset.monitorPanelId as MonitorPanelId | undefined;
        const rect = el.getBoundingClientRect();
        return id ? { id, top: rect.top, bottom: rect.bottom, height: rect.height } : null;
      })
      .filter((r): r is PanelBaseRect => r !== null);

    const gap = measurePanelGap(baseRects);
    const startScrollTop = container?.scrollTop ?? 0;

    const initial: PanelDragState = {
      panelId,
      fromIndex,
      targetIndex: fromIndex,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      offsetX: cardRect ? e.clientX - cardRect.left : 16,
      offsetY: cardRect ? e.clientY - cardRect.top : 16,
      draggedWidth: cardRect?.width ?? 0,
      draggedHeight: cardRect?.height ?? 0,
      startScrollTop,
      gap,
      baseRects,
      active: false,
    };
    panelDragRef.current = initial;
    setPanelDrag(initial);
  };

  const handleAddPanel = (id: MonitorPanelId) => {
    monitorPanelService.addPanel(id);
    setAddMenuOpen(false);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const el = bodyScrollRef.current?.querySelector<HTMLElement>(
          `[data-monitor-panel-id="${id}"]`,
        );
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }
  };

  const handleAddAllPanels = () => {
    monitorPanelService.addAllPanels();
    setAddMenuOpen(false);
  };

  const handleResetPanels = () => {
    capturePanelRects();
    monitorPanelService.resetPanels();
    setAddMenuOpen(false);
  };

  const handleRemovePanel = (id: MonitorPanelId) => {
    capturePanelRects();
    monitorPanelService.removePanel(id);
  };

  const handleDetachPanel = (id: MonitorPanelId) => {
    const meta = MONITOR_PANEL_META_MAP[id];
    const originLoc = layoutService.getViewportLocation(viewport.id);
    const targetDock =
      originLoc === 'left-drawer' || originLoc === 'right-drawer' ? originLoc : meta.defaultPosition;
    capturePanelRects();
    layoutService.detachToViewport({
      typeId: meta.viewportTypeId,
      pluginId: 'lighterm.monitor',
      title: meta.title,
      params: { panelId: id },
      dockRatio: meta.defaultDockRatio,
      floatRect: meta.defaultFloatSize,
      originViewportId: viewport.id,
      preferredDock: targetDock,
      onCommit: () => {
        monitorPanelService.removePanel(id);
      },
    });
  };

  const handleKeyboardReorder = (id: MonitorPanelId, index: number, delta: -1 | 1) => {
    const targetIdx = index + delta;
    if (targetIdx < 0 || targetIdx >= panels.length) return;
    capturePanelRects();
    monitorPanelService.movePanelByDelta(id, delta);
  };

  const animateDisplacement = isDragActive && !prefersReducedMotion();

  const renderPanel = (panelId: MonitorPanelId, index: number, isGhost = false) => {
    if (!stats) return null;
    const meta = MONITOR_PANEL_META_MAP[panelId];
    const isPlaceholder = !isGhost && Boolean(isDragActive && panelDrag?.panelId === panelId);
    const displacementY =
      !isGhost && isDragActive && panelDrag
        ? computeCardDisplacementY(
            panelDrag.baseRects,
            panelDrag.fromIndex,
            panelDrag.targetIndex,
            index,
            panelDrag.gap,
          )
        : 0;
    const extras = getPanelHeaderExtras(panelId, telemetry);
    const canDetach = Boolean(harnessKernel.getViewportDescriptor(meta.viewportTypeId));

    return (
      <StatusPanelCard
        key={panelId}
        panelId={panelId}
        title={meta.title}
        icon={extras.icon}
        headerMeta={extras.headerMeta}
        headerRight={extras.headerRight}
        isGhost={isGhost}
        isPlaceholder={isPlaceholder}
        placeholderHeight={panelDrag?.draggedHeight ?? 0}
        isDragActive={!isGhost && isDragActive}
        displacementY={displacementY}
        animateDisplacement={!isGhost && animateDisplacement}
        onHeaderPointerDown={(e: React.PointerEvent) => startPanelDrag(e, panelId, index)}
        onKeyboardReorder={(delta: -1 | 1) => handleKeyboardReorder(panelId, index, delta)}
        onDetach={canDetach ? () => handleDetachPanel(panelId) : undefined}
        onRemove={() => handleRemovePanel(panelId)}
      >
        {renderPanelBodyContent(panelId, telemetry)}
      </StatusPanelCard>
    );
  };

  return (
    <aside
      ref={asideRef}
      aria-label="System Status Panel"
      className="flex-1 flex flex-col min-w-0 min-h-0 select-none text-xs"
      style={{ backgroundColor: 'var(--bg-surface)' }}
    >
      {/* Toolbar */}
      <div className="h-8 px-2.5 flex items-center justify-between border-b border-[var(--border-subtle)] shrink-0">
        <span className="text-[11px] font-medium text-[var(--text-muted)] truncate">
          {targetKey === 'local' ? 'Local Telemetry' : `Remote (${activeHostConfig?.host ?? 'SSH'})`}
        </span>
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Add / Manage Status Panels Menu */}
          <div ref={addMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setAddMenuOpen((v) => !v)}
              title="Add Status Panel"
              aria-label="Add Status Panel"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              className={`relative p-1 rounded hover:bg-[var(--bg-elevated)] ${
                missingPanels.length > 0
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              {missingPanels.length > 0 && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
              )}
            </button>

            {addMenuOpen && (
              <div
                role="menu"
                aria-label="Add Status Panel Menu"
                className="lighterm-pop-enter absolute -right-10 top-full mt-1 z-50 w-52 py-1.5 rounded-lg border shadow-2xl text-xs"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Status Panels
                </div>
                {MONITOR_PANEL_CATALOG.map((meta) => {
                  const Icon = PANEL_ICON_MAP[meta.id];
                  const isAdded = panels.includes(meta.id);
                  return (
                    <button
                      key={meta.id}
                      type="button"
                      role="menuitem"
                      disabled={isAdded}
                      title={meta.description}
                      onClick={() => handleAddPanel(meta.id)}
                      className={`w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left transition-colors ${
                        isAdded
                          ? 'text-[var(--text-muted)] cursor-default opacity-75'
                          : 'text-[var(--text-primary)] hover:bg-[var(--accent)]/20'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Icon
                          className={`w-3.5 h-3.5 shrink-0 ${
                            isAdded ? 'text-[var(--text-muted)]' : PANEL_ICON_COLOR_MAP[meta.id]
                          }`}
                        />
                        <span className="truncate">{meta.title}</span>
                      </span>
                      {isAdded ? (
                        <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)] shrink-0">
                          <Check className="w-3 h-3 text-[var(--success)]" />
                          Added
                        </span>
                      ) : (
                        <Plus className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                      )}
                    </button>
                  );
                })}

                <div className="my-1 border-t border-[var(--border-subtle)]" />

                {missingPanels.length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={handleAddAllPanels}
                    className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    <span>Add All Panels</span>
                  </button>
                )}

                <button
                  type="button"
                  role="menuitem"
                  disabled={isDefaultLayout}
                  onClick={handleResetPanels}
                  className={`w-full px-3 py-1.5 flex items-center gap-2 text-left transition-colors ${
                    isDefaultLayout
                      ? 'text-[var(--text-muted)] opacity-50 cursor-default'
                      : 'text-[var(--text-primary)] hover:bg-[var(--accent)]/20'
                  }`}
                >
                  <RotateCcw className="w-3.5 h-3.5 shrink-0" />
                  <span>Reset Default Layout</span>
                </button>
              </div>
            )}
          </div>

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
        </div>
      </div>

      {/* Body */}
      <div
        ref={bodyScrollRef}
        className={`flex-1 min-h-0 overflow-y-auto lighterm-scroll p-2.5 space-y-3 ${
          isDragActive ? 'cursor-grabbing' : ''
        }`}
      >
        {error && (
          <div className="p-2 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[11px] text-[var(--danger)] break-words">
            {error}
          </div>
        )}

        {panels.length === 0 ? (
          <div
            aria-label="Empty Status Panels"
            className="p-4 rounded-lg border border-dashed border-[var(--border-subtle)] bg-[var(--bg-app)]/35 text-center space-y-2.5"
          >
            <div className="text-[11px] text-[var(--text-muted)]">No status panels visible</div>
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setAddMenuOpen(true)}
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Add Panel
              </button>
              <button
                type="button"
                onClick={handleResetPanels}
                className="px-2.5 py-1 rounded text-[11px] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
              >
                <RotateCcw className="w-3 h-3" />
                Restore Defaults
              </button>
            </div>
          </div>
        ) : !stats && !error ? (
          <div className="py-10 text-center text-[var(--text-muted)]">Collecting metrics...</div>
        ) : stats ? (
          panels.map((panelId, index) => renderPanel(panelId, index))
        ) : null}
      </div>

      {/* Translucent Floating Panel Drag Ghost */}
      {isDragActive && stats && panelDrag && (
        <div
          data-monitor-drag-ghost={panelDrag.panelId}
          aria-hidden="true"
          style={{
            left: panelDrag.currentX - panelDrag.offsetX,
            top: panelDrag.currentY - panelDrag.offsetY,
            width: panelDrag.draggedWidth > 0 ? panelDrag.draggedWidth : undefined,
            opacity: 0.72,
            backgroundColor: 'var(--bg-surface)',
          }}
          className="fixed z-50 pointer-events-none rounded-lg shadow-2xl ring-1 ring-[var(--accent)]/70 backdrop-blur-sm scale-[1.02]"
        >
          {renderPanel(panelDrag.panelId, panelDrag.fromIndex, true)}
        </div>
      )}
    </aside>
  );
};
