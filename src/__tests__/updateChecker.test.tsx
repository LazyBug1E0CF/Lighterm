import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsModal } from '../components/settings/SettingsModal';
import { ShellTopBar } from '../components/shell/ShellTopBar';
import { UpdateModal } from '../components/shell/UpdateModal';
import { useShellStore } from '../core/shellService';
import {
  PERIODIC_UPDATE_CHECK_INTERVAL_MS,
  STARTUP_UPDATE_CHECK_DELAY_MS,
  updateService,
  useUpdateStore,
} from '../core/updateService';
import { KernelProvider } from '../kernel/KernelContext';
import { pluginKernel } from '../kernel/PluginKernel';
import { resetLightermKernelForTesting } from '../plugins';
import type {
  DownloadedUpdate,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdatePreferences,
} from '../types';

const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}));

function makeUpdateResult(overrides?: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    currentVersion: '0.1.0',
    latestVersion: '0.3.1',
    latestTag: 'v0.3.1',
    releaseUrl: 'https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.3.1',
    publishedAt: '2026-11-24T00:00:00Z',
    hasUpdate: true,
    isSkipped: false,
    skippedVersion: null,
    autoCheck: true,
    checkedAt: 1_764_000_000_000,
    releases: [
      {
        tagName: 'v0.3.1',
        version: '0.3.1',
        name: 'v0.3.1',
        body: '- feat: add built-in GitHub Release update checker\n- fix: SFTP nested drag-and-drop stall',
        htmlUrl: 'https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.3.1',
        publishedAt: '2026-11-24T00:00:00Z',
        isLatest: true,
      },
      {
        tagName: 'v0.3.0',
        version: '0.3.0',
        name: 'v0.3.0',
        body: '- feat: ship self-hosted Web App (`lighterm-server`)',
        htmlUrl: 'https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.3.0',
        publishedAt: '2026-11-10T00:00:00Z',
        isLatest: false,
      },
      {
        tagName: 'v0.2.0',
        version: '0.2.0',
        name: 'v0.2.0',
        body: '- feat: add GitHub Config Sync with AES-256-GCM encryption',
        htmlUrl: 'https://github.com/LazyBug1E0CF/Lighterm/releases/tag/v0.2.0',
        publishedAt: '2026-10-25T00:00:00Z',
        isLatest: false,
      },
    ],
    asset: {
      name: 'Lighterm-Setup-0.3.1-x64.exe',
      downloadUrl:
        'https://github.com/LazyBug1E0CF/Lighterm/releases/download/v0.3.1/Lighterm-Setup-0.3.1-x64.exe',
      size: 18_400_000,
      contentType: 'application/octet-stream',
      sha256Url:
        'https://github.com/LazyBug1E0CF/Lighterm/releases/download/v0.3.1/Lighterm-Setup-0.3.1-x64.exe.sha256',
    },
    canAutoDownload: true,
    ...overrides,
  };
}

describe('GitHub Release Update Checker UI & Flows', () => {
  const eventHandlers = new Map<string, (ev: { payload: unknown }) => void>();

  beforeEach(() => {
    window.localStorage.clear();
    resetLightermKernelForTesting();
    mockInvoke.mockReset();
    mockListen.mockReset();
    eventHandlers.clear();
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    mockListen.mockImplementation(
      async (eventName: string, cb: (ev: { payload: unknown }) => void) => {
        eventHandlers.set(eventName, cb);
        return () => {
          eventHandlers.delete(eventName);
        };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    resetLightermKernelForTesting();
  });

  it('shows Scheme A update icon next to Lighterm title, opens aggregated modal, and handles Cancel vs Skip This Version', async () => {
    let savedPrefs: UpdatePreferences = {
      autoCheck: true,
      skippedVersion: null,
      lastCheckedAt: null,
    };

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'updater_get_state') return savedPrefs;
      if (cmd === 'updater_check') return makeUpdateResult({ skippedVersion: savedPrefs.skippedVersion });
      if (cmd === 'updater_save_preferences') {
        savedPrefs = args?.preferences as UpdatePreferences;
        return savedPrefs;
      }
      return null;
    });

    await updateService.initialize();
    render(
      <KernelProvider kernel={pluginKernel}>
        <ShellTopBar />
        <UpdateModal />
      </KernelProvider>,
    );

    expect(screen.queryByLabelText(/Update available/i)).toBeNull();

    await act(async () => {
      await updateService.checkForUpdates({ manual: true });
    });

    const header = screen.getByRole('banner');
    const titleEl = within(header).getByText('Lighterm');
    const updateBtn = within(header).getByLabelText('Update available: v0.3.1');
    expect(titleEl.nextElementSibling).toBe(updateBtn);

    // Click icon -> opens modal with aggregated changelog v0.3.1, v0.3.0, v0.2.0
    fireEvent.click(updateBtn);
    const dialog = await screen.findByRole('dialog', { name: 'Update Available' });
    expect(within(dialog).getByText(/3 releases since v0\.1\.0/i)).toBeTruthy();
    const timeline = within(dialog).getByLabelText('Aggregated Release Notes');
    expect(within(timeline).getByText('v0.3.1')).toBeTruthy();
    expect(within(timeline).getByText('v0.3.0')).toBeTruthy();
    expect(within(timeline).getByText('v0.2.0')).toBeTruthy();
    expect(within(timeline).getByText('Current installed version: v0.1.0')).toBeTruthy();

    // Collapse v0.3.0 release notes card
    const v030Btn = within(dialog).getByRole('button', { name: /v0\.3\.0/i });
    expect(v030Btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(v030Btn);
    expect(v030Btn.getAttribute('aria-expanded')).toBe('false');

    // Cancel closes modal but keeps top-left update icon visible
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Update Available' })).toBeNull();
    expect(within(header).getByLabelText('Update available: v0.3.1')).toBeTruthy();

    // Re-open and Skip This Version -> hides top-left icon and persists skippedVersion
    fireEvent.click(within(header).getByLabelText('Update available: v0.3.1'));
    const dialog2 = await screen.findByRole('dialog', { name: 'Update Available' });
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Skip This Version' }));

    await waitFor(() => {
      expect(savedPrefs.skippedVersion).toBe('0.3.1');
      expect(screen.queryByRole('dialog', { name: 'Update Available' })).toBeNull();
      expect(within(header).queryByLabelText(/Update available/i)).toBeNull();
    });
  });

  it('streams download progress, supports cancellation, handles errors, and launches installer on Install & Restart', async () => {
    let resolveDownload: ((val: DownloadedUpdate) => void) | null = null;
    let rejectDownload: ((err: Error) => void) | null = null;
    let downloadAttempt = 0;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'updater_get_state') {
        return { autoCheck: true, skippedVersion: null, lastCheckedAt: null };
      }
      if (cmd === 'updater_check') {
        return makeUpdateResult();
      }
      if (cmd === 'updater_download') {
        downloadAttempt += 1;
        return new Promise<DownloadedUpdate>((resolve, reject) => {
          resolveDownload = resolve;
          rejectDownload = reject;
        });
      }
      if (cmd === 'updater_cancel_download') {
        return null;
      }
      if (cmd === 'updater_install') {
        return null;
      }
      return null;
    });

    await updateService.initialize();
    await updateService.checkForUpdates({ manual: true });
    act(() => {
      updateService.openModal();
    });

    render(
      <KernelProvider kernel={pluginKernel}>
        <ShellTopBar />
        <UpdateModal />
      </KernelProvider>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Update Available' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update Now' }));

    await waitFor(() => {
      expect(downloadAttempt).toBe(1);
    });
    const firstDownloadId = useUpdateStore.getState().activeDownloadId!;
    expect(firstDownloadId).toBeTruthy();

    // Emit downloading & verifying progress events
    const emitProgress = eventHandlers.get('updater:progress');
    expect(emitProgress).toBeTruthy();

    act(() => {
      emitProgress!({
        payload: {
          downloadId: firstDownloadId,
          version: '0.3.1',
          assetName: 'Lighterm-Setup-0.3.1-x64.exe',
          stage: 'downloading',
          downloadedBytes: 9_200_000,
          totalBytes: 18_400_000,
          speedBytesPerSec: 4_000_000,
          progressPercent: 50,
          sha256Verified: false,
        } satisfies UpdateDownloadProgress,
      });
    });

    expect(within(dialog).getByText(/50%/)).toBeTruthy();

    // Cancel active download -> invokes updater_cancel_download and returns to idle
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel Download' }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('updater_cancel_download', {
        downloadId: firstDownloadId,
      });
      expect(useUpdateStore.getState().downloadStatus).toBe('idle');
    });

    // Reject first stale promise after cancellation -> remains idle
    await act(async () => {
      rejectDownload?.(new Error('Update download cancelled'));
    });
    expect(useUpdateStore.getState().downloadStatus).toBe('idle');

    // Start second download -> verify error fallback & retry -> succeed
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update Now' }));
    await waitFor(() => {
      expect(downloadAttempt).toBe(2);
    });
    await act(async () => {
      rejectDownload?.(new Error('Connection reset by peer'));
    });

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText(/Connection reset by peer/i)).toBeTruthy();

    // Retry and complete with SHA-256 verification
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry Update' }));
    await waitFor(() => {
      expect(downloadAttempt).toBe(3);
    });
    const thirdId = useUpdateStore.getState().activeDownloadId!;
    act(() => {
      emitProgress!({
        payload: {
          downloadId: thirdId,
          version: '0.3.1',
          assetName: 'Lighterm-Setup-0.3.1-x64.exe',
          stage: 'verifying',
          downloadedBytes: 18_400_000,
          totalBytes: 18_400_000,
          speedBytesPerSec: 6_000_000,
          progressPercent: 100,
          sha256Verified: false,
        } satisfies UpdateDownloadProgress,
      });
    });
    expect(within(dialog).getByText(/Verifying SHA-256 checksum/i)).toBeTruthy();

    await act(async () => {
      resolveDownload?.({
        downloadId: thirdId,
        version: '0.3.1',
        assetName: 'Lighterm-Setup-0.3.1-x64.exe',
        filePath: 'C:\\Users\\test\\AppData\\Roaming\\lighterm\\updates\\0.3.1\\Lighterm-Setup-0.3.1-x64.exe',
        sizeBytes: 18_400_000,
        sha256: 'a'.repeat(64),
        sha256Verified: true,
      });
    });

    expect(await within(dialog).findByText(/SHA-256 checksum verified/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install & Restart' }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('updater_install', {
        filePath:
          'C:\\Users\\test\\AppData\\Roaming\\lighterm\\updates\\0.3.1\\Lighterm-Setup-0.3.1-x64.exe',
      });
    });
  });

  it('supports Settings -> Updates manual check, auto-check toggle, and resetting skipped version', async () => {
    let savedPrefs: UpdatePreferences = {
      autoCheck: true,
      skippedVersion: '0.3.1',
      lastCheckedAt: 1_764_000_000_000,
    };

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'updater_get_state') return savedPrefs;
      if (cmd === 'updater_save_preferences') {
        savedPrefs = args?.preferences as UpdatePreferences;
        return savedPrefs;
      }
      if (cmd === 'updater_check') {
        return makeUpdateResult({
          autoCheck: savedPrefs.autoCheck,
          skippedVersion: savedPrefs.skippedVersion,
          isSkipped: savedPrefs.skippedVersion === '0.3.1',
        });
      }
      return null;
    });

    await updateService.initialize();
    act(() => {
      useShellStore.setState({ settingsModalOpen: true, settingsActiveTab: 'updates' });
    });

    render(
      <KernelProvider kernel={pluginKernel}>
        <ShellTopBar />
        <SettingsModal />
        <UpdateModal />
      </KernelProvider>,
    );

    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(settingsDialog).getByText(/Skipped Version:/i)).toBeTruthy();

    fireEvent.click(within(settingsDialog).getByRole('button', { name: 'Check for Updates' }));
    expect(await within(settingsDialog).findByText(/Version v0\.3\.1 is available/i)).toBeTruthy();
    expect(screen.queryByLabelText('Update available: v0.3.1')).toBeNull();

    // Reset skipped version -> topbar update icon immediately appears
    fireEvent.click(within(settingsDialog).getAllByRole('button', { name: 'Reset Skipped Version' })[0]);
    await waitFor(() => {
      expect(savedPrefs.skippedVersion).toBeNull();
      expect(screen.getByLabelText('Update available: v0.3.1')).toBeTruthy();
    });

    // Toggle auto-check off
    const autoCheckBox = within(settingsDialog).getByLabelText(
      'Check for updates automatically',
    ) as HTMLInputElement;
    expect(autoCheckBox.checked).toBe(true);
    fireEvent.click(autoCheckBox);
    await waitFor(() => {
      expect(savedPrefs.autoCheck).toBe(false);
    });
  });

  it('schedules startup delayed check and periodic 6h checks when autoCheck is enabled, and skips when disabled', async () => {
    vi.useFakeTimers();

    mockInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'updater_get_state') {
        return { autoCheck: true, skippedVersion: null, lastCheckedAt: null };
      }
      if (cmd === 'updater_save_preferences') {
        return args?.preferences as UpdatePreferences;
      }
      if (cmd === 'updater_check') {
        return makeUpdateResult();
      }
      return null;
    });

    await act(async () => {
      await updateService.initialize();
    });

    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'updater_check')).toHaveLength(0);

    // Advance past 5s startup delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STARTUP_UPDATE_CHECK_DELAY_MS + 50);
    });
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'updater_check')).toHaveLength(1);

    // Advance 6h periodic interval
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PERIODIC_UPDATE_CHECK_INTERVAL_MS);
    });
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'updater_check')).toHaveLength(2);

    // Disable autoCheck -> subsequent 6h interval does not check automatically
    await act(async () => {
      await updateService.setAutoCheck(false);
      await vi.advanceTimersByTimeAsync(PERIODIC_UPDATE_CHECK_INTERVAL_MS);
    });
    expect(mockInvoke.mock.calls.filter((c) => c[0] === 'updater_check')).toHaveLength(2);
  });
});
