import { hasBackendRuntime, invokeBackend } from '../../core/ipc';
import type { HostConfig, SessionKind, SystemStats } from '../../types';

export async function fetchSystemStats(params: {
  kind: SessionKind;
  hostId?: string;
  hostConfig?: HostConfig;
}): Promise<SystemStats> {
  if (hasBackendRuntime()) {
    return invokeBackend<SystemStats>('monitor_get_stats', params);
  }

  const now = Date.now();
  const wave = (Math.sin(now / 1800) + 1) * 0.5;
  const isSsh = params.kind === 'ssh';
  const hostLabel = params.hostConfig?.host ?? (isSsh ? 'prod-node-01' : 'lighterm-local');
  const cpuUsage = Number((14 + wave * 34).toFixed(1));
  const totalMem = isSsh ? 16 * 1024 ** 3 : 32 * 1024 ** 3;
  const usedMem = Math.round(totalMem * (0.42 + wave * 0.14));

  return {
    source: params.kind,
    hostname: hostLabel,
    osName: isSsh ? 'Debian GNU/Linux 13' : 'Windows / Lighterm Preview',
    kernelVersion: '6.12.0-amd64',
    arch: 'x86_64',
    uptimeSecs: isSsh ? 842100 : 19420,
    loadAvg: [0.68 + wave * 0.4, 0.54, 0.41],
    cpuUsagePercent: cpuUsage,
    cpuCores: isSsh ? 8 : 16,
    memTotalBytes: totalMem,
    memUsedBytes: usedMem,
    swapTotalBytes: 4 * 1024 ** 3,
    swapUsedBytes: Math.round(512 * 1024 ** 2 * wave),
    netRxBytesPerSec: Math.round(128 * 1024 + wave * 420 * 1024),
    netTxBytesPerSec: Math.round(48 * 1024 + wave * 180 * 1024),
    netTotalRxBytes: 1.48 * 1024 ** 3,
    netTotalTxBytes: 0.62 * 1024 ** 3,
    disks: [
      {
        name: '/dev/nvme0n1p2',
        mountPoint: '/',
        fsType: 'ext4',
        totalBytes: 512 * 1024 ** 3,
        usedBytes: 214 * 1024 ** 3,
        usagePercent: 41.8,
      },
      {
        name: '/dev/nvme0n1p3',
        mountPoint: '/data',
        fsType: 'ext4',
        totalBytes: 1024 * 1024 ** 3,
        usedBytes: 640 * 1024 ** 3,
        usagePercent: 62.5,
      },
    ],
    topProcesses: [
      { pid: 1420, name: isSsh ? 'nginx' : 'lighterm', cpuPercent: 4.8, memoryBytes: 180 * 1024 ** 2 },
      { pid: 892, name: isSsh ? 'postgres' : 'rust-analyzer', cpuPercent: 3.1, memoryBytes: 420 * 1024 ** 2 },
      { pid: 412, name: 'dockerd', cpuPercent: 1.9, memoryBytes: 260 * 1024 ** 2 },
    ],
    sampledAt: now,
  };
}
