import { create } from 'zustand';
import type {
  DownloadedUpdate,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadStatus,
  UpdatePreferences,
} from '../types';
import {
  hasBackendRuntime,
  invokeBackend,
  isTauriRuntime,
  isWebRuntime,
  listenBackend,
  makeUuid,
  readLs,
  writeLs,
} from './ipc';
import { resolveApiUrl } from './webTransport';

export const STARTUP_UPDATE_CHECK_DELAY_MS = 5_000;
export const PERIODIC_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const WEB_RESTART_POLL_INTERVAL_MS = 1_000;
export const WEB_RESTART_TIMEOUT_MS = 60_000;

const LS_UPDATE_PREFS = 'lighterm:update-prefs';

export function createDefaultUpdatePreferences(): UpdatePreferences {
  return {
    autoCheck: true,
    skippedVersion: null,
    lastCheckedAt: null,
  };
}

export interface UpdateStoreState {
  initialized: boolean;
  checking: boolean;
  modalOpen: boolean;
  preferences: UpdatePreferences;
  result: UpdateCheckResult | null;
  checkError: string | null;
  downloadStatus: UpdateDownloadStatus;
  activeDownloadId: string | null;
  progress: UpdateDownloadProgress | null;
  downloaded: DownloadedUpdate | null;
  downloadError: string | null;
}

export const useUpdateStore = create<UpdateStoreState>(() => ({
  initialized: false,
  checking: false,
  modalOpen: false,
  preferences: createDefaultUpdatePreferences(),
  result: null,
  checkError: null,
  downloadStatus: 'idle',
  activeDownloadId: null,
  progress: null,
  downloaded: null,
  downloadError: null,
}));

let initPromise: Promise<void> | null = null;
let inFlightCheckPromise: Promise<UpdateCheckResult | null> | null = null;
let unlistenProgress: (() => void) | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let restartPollTimer: ReturnType<typeof setTimeout> | null = null;
let restartSessionToken = 0;
const cancelledDownloadIds = new Set<string>();

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function normalizePreferences(
  raw: unknown,
  fallback: UpdatePreferences = createDefaultUpdatePreferences(),
): UpdatePreferences {
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }
  const obj = raw as Record<string, unknown>;
  return {
    autoCheck: typeof obj.autoCheck === 'boolean' ? obj.autoCheck : fallback.autoCheck,
    skippedVersion:
      'skippedVersion' in obj
        ? typeof obj.skippedVersion === 'string' && obj.skippedVersion.trim()
          ? obj.skippedVersion.trim()
          : null
        : (fallback.skippedVersion ?? null),
    lastCheckedAt:
      typeof obj.lastCheckedAt === 'number' && Number.isFinite(obj.lastCheckedAt)
        ? obj.lastCheckedAt
        : (fallback.lastCheckedAt ?? null),
  };
}

function parseSemverTuple(raw: string): [number, number, number] | null {
  const clean = raw.trim().replace(/^[vV]/, '').split(/[+-]/)[0] ?? '';
  if (!clean) return null;
  const parts = clean.split('.');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

function isVersionSkipped(latestVersion: string, skippedVersion?: string | null): boolean {
  if (!skippedVersion) return false;
  const latest = parseSemverTuple(latestVersion);
  const skipped = parseSemverTuple(skippedVersion);
  if (!latest || !skipped) {
    return latestVersion.trim() === skippedVersion.trim();
  }
  for (let i = 0; i < 3; i += 1) {
    if (skipped[i] > latest[i]) return true;
    if (skipped[i] < latest[i]) return false;
  }
  return true;
}

function clearTimers(): void {
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  if (restartPollTimer !== null) {
    clearTimeout(restartPollTimer);
    restartPollTimer = null;
  }
}

export class UpdateService {
  async initialize(): Promise<void> {
    if (useUpdateStore.getState().initialized) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      let prefs = createDefaultUpdatePreferences();
      if (hasBackendRuntime()) {
        try {
          const loaded = await invokeBackend<UpdatePreferences>('updater_get_state');
          prefs = normalizePreferences(loaded);
        } catch {
          prefs = createDefaultUpdatePreferences();
        }
      } else {
        prefs = normalizePreferences(
          readLs<UpdatePreferences>(LS_UPDATE_PREFS, createDefaultUpdatePreferences),
        );
      }

      useUpdateStore.setState({
        initialized: true,
        preferences: prefs,
      });

      if (hasBackendRuntime() && !unlistenProgress) {
        try {
          unlistenProgress = await listenBackend<UpdateDownloadProgress>(
            'updater:progress',
            (payload) => {
              const state = useUpdateStore.getState();
              if (!payload || state.activeDownloadId !== payload.downloadId) {
                return;
              }
              if (payload.stage === 'cancelled') {
                useUpdateStore.setState({
                  downloadStatus: 'idle',
                  activeDownloadId: null,
                  progress: null,
                  downloadError: null,
                });
                return;
              }
              if (payload.stage === 'error') {
                useUpdateStore.setState({
                  downloadStatus: 'error',
                  progress: payload,
                  downloadError: payload.error ?? 'Download failed',
                });
                return;
              }
              if (payload.stage === 'verifying') {
                useUpdateStore.setState({
                  downloadStatus: 'verifying',
                  progress: payload,
                });
                return;
              }
              if (payload.stage === 'ready') {
                useUpdateStore.setState({
                  downloadStatus: 'ready',
                  progress: payload,
                  downloadError: null,
                });
                return;
              }
              useUpdateStore.setState({
                downloadStatus: 'downloading',
                progress: payload,
                downloadError: null,
              });
            },
          );
        } catch {
          unlistenProgress = null;
        }
      }

      if (hasBackendRuntime()) {
        clearTimers();
        startupTimer = setTimeout(() => {
          startupTimer = null;
          if (useUpdateStore.getState().preferences.autoCheck) {
            void this.checkForUpdates({ manual: false });
          }
        }, STARTUP_UPDATE_CHECK_DELAY_MS);

        periodicTimer = setInterval(() => {
          if (useUpdateStore.getState().preferences.autoCheck) {
            void this.checkForUpdates({ manual: false });
          }
        }, PERIODIC_UPDATE_CHECK_INTERVAL_MS);
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });

    return initPromise;
  }

  async checkForUpdates(options?: { manual?: boolean }): Promise<UpdateCheckResult | null> {
    const manual = options?.manual ?? false;
    if (inFlightCheckPromise) return inFlightCheckPromise;

    if (!hasBackendRuntime()) {
      if (manual) {
        useUpdateStore.setState({
          checking: false,
          checkError: 'Update checks require an active desktop or web backend.',
        });
      }
      return null;
    }

    useUpdateStore.setState({
      checking: true,
      ...(manual ? { checkError: null } : {}),
    });

    inFlightCheckPromise = (async () => {
      try {
        const res = await invokeBackend<UpdateCheckResult>('updater_check');
        if (!res || typeof res !== 'object') {
          return null;
        }
        useUpdateStore.setState((state) => ({
          checking: false,
          result: res,
          checkError: null,
          preferences: {
            autoCheck:
              typeof res.autoCheck === 'boolean' ? res.autoCheck : state.preferences.autoCheck,
            skippedVersion: res.skippedVersion ?? null,
            lastCheckedAt: res.checkedAt ?? Date.now(),
          },
        }));
        return res;
      } catch (err) {
        useUpdateStore.setState({
          checking: false,
          ...(manual ? { checkError: formatErrorMessage(err) } : {}),
        });
        return null;
      } finally {
        inFlightCheckPromise = null;
      }
    })();

    return inFlightCheckPromise;
  }

  openModal(): void {
    if (!useUpdateStore.getState().result?.hasUpdate) return;
    useUpdateStore.setState({ modalOpen: true });
  }

  closeModal(): void {
    useUpdateStore.setState({ modalOpen: false });
  }

  private async savePreferences(nextPrefs: UpdatePreferences): Promise<UpdatePreferences> {
    const saved = hasBackendRuntime()
      ? normalizePreferences(
          await invokeBackend<UpdatePreferences>('updater_save_preferences', {
            preferences: nextPrefs,
          }),
          nextPrefs,
        )
      : (() => {
          writeLs(LS_UPDATE_PREFS, nextPrefs);
          return nextPrefs;
        })();

    useUpdateStore.setState((state) => ({
      preferences: saved,
      result: state.result
        ? {
            ...state.result,
            autoCheck: saved.autoCheck,
            skippedVersion: saved.skippedVersion ?? null,
            isSkipped:
              state.result.hasUpdate &&
              isVersionSkipped(state.result.latestVersion, saved.skippedVersion),
          }
        : null,
    }));
    return saved;
  }

  async skipCurrentVersion(): Promise<void> {
    const state = useUpdateStore.getState();
    const version = state.result?.latestVersion;
    if (!version) return;
    await this.savePreferences({
      ...state.preferences,
      skippedVersion: version,
    });
    useUpdateStore.setState({ modalOpen: false });
  }

  async clearSkippedVersion(): Promise<void> {
    const state = useUpdateStore.getState();
    await this.savePreferences({
      ...state.preferences,
      skippedVersion: null,
    });
  }

  async setAutoCheck(autoCheck: boolean): Promise<void> {
    const state = useUpdateStore.getState();
    await this.savePreferences({
      ...state.preferences,
      autoCheck,
    });
  }

  async startDownload(): Promise<void> {
    const state = useUpdateStore.getState();
    const result = state.result;
    if (!result || !result.hasUpdate) return;

    if (!hasBackendRuntime() || !result.canAutoDownload || !result.asset) {
      await this.openReleasePage(result.releaseUrl);
      return;
    }

    const downloadId = makeUuid('upd');
    const asset = result.asset;

    useUpdateStore.setState({
      downloadStatus: 'downloading',
      activeDownloadId: downloadId,
      downloaded: null,
      downloadError: null,
      progress: {
        downloadId,
        version: result.latestVersion,
        assetName: asset.name,
        stage: 'downloading',
        downloadedBytes: 0,
        totalBytes: asset.size,
        speedBytesPerSec: 0,
        progressPercent: 0,
        sha256Verified: false,
      },
    });

    try {
      const downloaded = await invokeBackend<DownloadedUpdate>('updater_download', {
        downloadId,
        version: result.latestVersion,
        asset,
      });
      if (cancelledDownloadIds.has(downloadId)) {
        cancelledDownloadIds.delete(downloadId);
        return;
      }
      if (useUpdateStore.getState().activeDownloadId !== downloadId) {
        return;
      }
      useUpdateStore.setState({
        downloadStatus: 'ready',
        downloaded,
        downloadError: null,
      });
    } catch (err) {
      if (cancelledDownloadIds.has(downloadId)) {
        cancelledDownloadIds.delete(downloadId);
        return;
      }
      useUpdateStore.setState({
        downloadStatus: 'error',
        downloadError: formatErrorMessage(err),
      });
    }
  }

  async cancelDownload(): Promise<void> {
    const downloadId = useUpdateStore.getState().activeDownloadId;
    if (downloadId) {
      cancelledDownloadIds.add(downloadId);
    }
    useUpdateStore.setState({
      downloadStatus: 'idle',
      activeDownloadId: null,
      progress: null,
      downloadError: null,
    });
    if (hasBackendRuntime() && downloadId) {
      try {
        await invokeBackend<void>('updater_cancel_download', { downloadId });
      } catch {
        // Ignore cancellation RPC errors after local reset
      }
    }
  }

  reloadBrowserPage(): void {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  }

  private waitForWebServerRestart(expectedVersion: string, previousVersion: string | null): void {
    restartSessionToken += 1;
    const token = restartSessionToken;
    if (restartPollTimer !== null) {
      clearTimeout(restartPollTimer);
      restartPollTimer = null;
    }

    const deadline = Date.now() + WEB_RESTART_TIMEOUT_MS;
    let sawDisconnect = false;

    const scheduleNext = () => {
      if (token !== restartSessionToken) return;
      restartPollTimer = setTimeout(() => {
        restartPollTimer = null;
        void poll();
      }, WEB_RESTART_POLL_INTERVAL_MS);
    };

    const poll = async () => {
      if (token !== restartSessionToken) return;
      if (useUpdateStore.getState().downloadStatus !== 'restarting') return;

      if (Date.now() > deadline) {
        useUpdateStore.setState({
          downloadStatus: 'error',
          downloadError: 'Server restart timed out. Please refresh the page to reconnect.',
        });
        return;
      }

      try {
        const res = await fetch(resolveApiUrl('api/health'), {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) {
          sawDisconnect = true;
        } else {
          const data = (await res.json().catch(() => null)) as {
            status?: string;
            version?: string;
          } | null;
          if (data?.status === 'ok') {
            const versionMatches = data.version === expectedVersion;
            const switchedVersion = Boolean(
              sawDisconnect && data.version && data.version !== previousVersion,
            );
            if (versionMatches || switchedVersion) {
              this.reloadBrowserPage();
              return;
            }
          }
        }
      } catch {
        sawDisconnect = true;
      }

      scheduleNext();
    };

    scheduleNext();
  }

  async installDownloadedUpdate(): Promise<void> {
    const downloaded = useUpdateStore.getState().downloaded;
    if (!downloaded) return;
    const previousVersion = useUpdateStore.getState().result?.currentVersion ?? null;
    try {
      await invokeBackend<void>('updater_install', { filePath: downloaded.filePath });
      if (isWebRuntime()) {
        useUpdateStore.setState({
          downloadStatus: 'restarting',
          downloadError: null,
        });
        this.waitForWebServerRestart(downloaded.version, previousVersion);
      }
    } catch (err) {
      useUpdateStore.setState({
        downloadStatus: 'error',
        downloadError: formatErrorMessage(err),
      });
    }
  }

  async openReleasePage(url?: string): Promise<void> {
    const targetUrl = (url ?? useUpdateStore.getState().result?.releaseUrl ?? '').trim();
    if (!targetUrl.startsWith('https://')) return;

    if (isTauriRuntime()) {
      await invokeBackend<void>('updater_open_url', { url: targetUrl });
      return;
    }

    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
    }
  }

  resetForTesting(): void {
    restartSessionToken += 1;
    clearTimers();
    unlistenProgress?.();
    unlistenProgress = null;
    initPromise = null;
    inFlightCheckPromise = null;
    cancelledDownloadIds.clear();
    useUpdateStore.setState({
      initialized: false,
      checking: false,
      modalOpen: false,
      preferences: createDefaultUpdatePreferences(),
      result: null,
      checkError: null,
      downloadStatus: 'idle',
      activeDownloadId: null,
      progress: null,
      downloaded: null,
      downloadError: null,
    });
  }
}

export const updateService = new UpdateService();
