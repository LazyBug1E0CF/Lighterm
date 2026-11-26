import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { SettingsModal } from '../components/settings/SettingsModal';
import {
  getRuntimeMode,
  hasBackendRuntime,
  invokeBackend,
  isTauriRuntime,
  isWebRuntime,
} from '../core/ipc';
import { shellService, useShellStore } from '../core/shellService';
import { useWebAuthStore, webAuth, type WebRuntimeConfig } from '../core/webTransport';
import { KernelProvider } from '../kernel/KernelContext';
import { pluginKernel } from '../kernel/PluginKernel';
import { useLayoutStore } from '../layout/layoutStore';
import { resetLightermKernelForTesting } from '../plugins';
import { sftpClient, useSftpPluginStore } from '../plugins/sftp/sftpClient';
import { SyncSettingsPage } from '../plugins/sync/SyncSettingsPage';

function setWebBootstrap(cfg?: Partial<WebRuntimeConfig>): void {
  window.__LIGHTERM_WEB__ = {
    mode: 'web',
    version: '0.1.0',
    authRequired: false,
    usernameRequired: false,
    authenticated: true,
    localShellEnabled: true,
    ...cfg,
  };
  webAuth.syncFromWindowConfig();
}

describe('Lighterm Web Runtime & Auth Transport', () => {
  const originalFetch = globalThis.fetch;

  let createObjectUrlSpy: { mockRestore(): void } | null = null;
  let revokeObjectUrlSpy: { mockRestore(): void } | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    delete window.__LIGHTERM_WEB__;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    resetLightermKernelForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    createObjectUrlSpy?.mockRestore();
    createObjectUrlSpy = null;
    revokeObjectUrlSpy?.mockRestore();
    revokeObjectUrlSpy = null;
    delete window.__LIGHTERM_WEB__;
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    resetLightermKernelForTesting();
  });

  it('detects preview, web, and tauri runtime modes cleanly', () => {
    expect(getRuntimeMode()).toBe('preview');
    expect(isTauriRuntime()).toBe(false);
    expect(isWebRuntime()).toBe(false);
    expect(hasBackendRuntime()).toBe(false);

    setWebBootstrap();
    expect(getRuntimeMode()).toBe('web');
    expect(isWebRuntime()).toBe(true);
    expect(hasBackendRuntime()).toBe(true);

    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(getRuntimeMode()).toBe('tauri');
    expect(isTauriRuntime()).toBe(true);
    expect(isWebRuntime()).toBe(false);
    expect(hasBackendRuntime()).toBe(true);
  });

  it('renders WebAuthGate when unauthenticated, logs in via API, hides desktop WindowControls, and shows web status', async () => {
    setWebBootstrap({
      authRequired: true,
      usernameRequired: true,
      authenticated: false,
      localShellEnabled: true,
    });

    const rpcCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/auth/login')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          username?: string;
          password?: string;
        };
        if (body.username === 'admin' && body.password === 'secret') {
          return new Response(
            JSON.stringify({
              authRequired: true,
              usernameRequired: true,
              authenticated: true,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({ code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.includes('/api/rpc/')) {
        const cmd = url.split('/api/rpc/')[1];
        rpcCalls.push(cmd);
        switch (cmd) {
          case 'settings_get':
            return new Response(
              JSON.stringify(useShellStore.getState().settings),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          case 'hosts_list':
          case 'workspaces_list':
          case 'snippets_list':
          case 'history_list':
          case 'plugins_list':
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'plugin_configs_get_all':
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'terminal_create_local':
            return new Response(
              JSON.stringify({
                id: 'web-term-1',
                kind: 'local',
                title: 'Terminal 1',
                hostId: null,
                cols: 100,
                rows: 30,
                status: 'connected',
                createdAt: Date.now(),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          case 'monitor_get_stats':
            return new Response(
              JSON.stringify({
                source: 'local',
                hostname: 'docker-host',
                osName: 'Linux',
                kernelVersion: '6.12',
                arch: 'x86_64',
                uptimeSecs: 100,
                loadAvg: [0.1, 0.1, 0.1],
                cpuUsagePercent: 12.5,
                cpuCores: 4,
                memTotalBytes: 8589934592,
                memUsedBytes: 2147483648,
                swapTotalBytes: 0,
                swapUsedBytes: 0,
                netRxBytesPerSec: 1024,
                netTxBytesPerSec: 512,
                netTotalRxBytes: 10240,
                netTotalTxBytes: 5120,
                disks: [],
                topProcesses: [],
                sampledAt: Date.now(),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          case 'sync_get_config':
            return new Response(
              JSON.stringify({
                config: {
                  enabled: true,
                  mode: 'gist',
                  apiBaseUrl: 'https://api.github.com',
                  oauthBaseUrl: 'https://github.com',
                  oauthClientId: '',
                  gistId: '',
                  gistFileName: 'lighterm-sync.json',
                  repoOwner: '',
                  repoName: 'lighterm-sync',
                  repoBranch: 'main',
                  repoFilePath: 'lighterm-sync.json',
                  autoCreateTarget: true,
                  autoSyncOnStartup: false,
                  autoSyncOnChange: false,
                  deviceName: 'Web',
                  conflictResolution: 'newest',
                  scopes: {
                    hosts: true,
                    settings: true,
                    workspaces: true,
                    snippets: true,
                    plugins: true,
                    includeHostSecrets: false,
                  },
                },
                isAuthenticated: false,
                account: null,
                oauthScopes: [],
                oauthClientConfigured: true,
                oauthClientIdSource: 'builtin',
                hasPassphrase: false,
                status: {},
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          default:
            return new Response(JSON.stringify(null), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
        }
      }

      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    render(<App />);

    const dialog = screen.getByRole('dialog', { name: 'Lighterm Web Sign In' });
    expect(dialog).toBeTruthy();

    fireEvent.change(within(dialog).getByPlaceholderText('Enter username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(within(dialog).getByPlaceholderText('Enter server access password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Sign In/i }));

    await waitFor(() => {
      expect(useWebAuthStore.getState().authenticated).toBe(true);
      expect(useShellStore.getState().initialized).toBe(true);
      expect(screen.getByRole('banner')).toBeTruthy();
    });

    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('group', { name: 'Window Controls' })).toBeNull();
    expect(within(header).getByLabelText('Sign Out')).toBeTruthy();
    expect(screen.getByLabelText('Web Connection Status')).toBeTruthy();
    expect(rpcCalls).toContain('settings_get');
  });

  it('distinguishes 422 SSH/GitHub auth failures from 401 WEB_AUTH_REQUIRED session expiry', async () => {
    setWebBootstrap({ authRequired: true, authenticated: true });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/rpc/terminal_create_ssh')) {
        return new Response(
          JSON.stringify({ code: 'AUTH_FAILED', message: 'Server rejected public key' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ code: 'WEB_AUTH_REQUIRED', message: 'Authentication required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await expect(
      invokeBackend('terminal_create_ssh', { hostId: 'h1', cols: 80, rows: 24 }),
    ).rejects.toThrow(/Server rejected public key/);
    expect(useWebAuthStore.getState().authenticated).toBe(true);

    await expect(invokeBackend('settings_get')).rejects.toThrow(/Authentication required/);
    expect(useWebAuthStore.getState().authenticated).toBe(false);
  });

  it('hides preview-only OAuth approval button in SyncSettingsPage during web mode', async () => {
    setWebBootstrap({ authRequired: false, authenticated: true });

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.endsWith('/api/rpc/sync_get_config') ||
        url.endsWith('/api/rpc/sync_save_config')
      ) {
        return new Response(
          JSON.stringify({
            config: {
              enabled: true,
              mode: 'gist',
              apiBaseUrl: 'https://api.github.com',
              oauthBaseUrl: 'https://github.com',
              oauthClientId: '',
              gistId: '',
              gistFileName: 'lighterm-sync.json',
              repoOwner: '',
              repoName: 'lighterm-sync',
              repoBranch: 'main',
              repoFilePath: 'lighterm-sync.json',
              autoCreateTarget: true,
              autoSyncOnStartup: false,
              autoSyncOnChange: false,
              deviceName: 'Docker Web',
              conflictResolution: 'newest',
              scopes: {
                hosts: true,
                settings: true,
                workspaces: true,
                snippets: true,
                plugins: true,
                includeHostSecrets: false,
              },
            },
            isAuthenticated: false,
            account: null,
            oauthScopes: [],
            oauthClientConfigured: true,
            oauthClientIdSource: 'builtin',
            hasPassphrase: false,
            status: {},
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/rpc/sync_oauth_start')) {
        return new Response(
          JSON.stringify({
            flowId: 'flow-web-1',
            userCode: 'WEB-1234',
            verificationUri: 'https://github.com/login/device',
            expiresIn: 900,
            interval: 60,
            scopes: ['gist'],
            browserOpened: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'pending', interval: 60, discoveredGists: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    render(<SyncSettingsPage pluginId="lighterm.sync" />);

    const signInBtn = await screen.findByRole('button', { name: /Sign in with GitHub/i });
    fireEvent.click(signInBtn);

    expect(await screen.findByText('WEB-1234')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Complete Preview Authorization/i })).toBeNull();
  });

  it('streams SFTP uploadFile and download via HTTP endpoints in web mode', async () => {
    setWebBootstrap({ authRequired: false, authenticated: true });

    const seenUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('/api/sftp/upload')) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sftp/download')) {
        return new Response('hello-sftp', {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }
      if (url.endsWith('/api/rpc/sftp_canonicalize')) {
        return new Response(JSON.stringify('/home/deploy'), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/rpc/sftp_list_dir')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    if (!URL.createObjectURL) {
      URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    } else {
      createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-url');
    }
    if (!URL.revokeObjectURL) {
      URL.revokeObjectURL = vi.fn();
    } else {
      revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    }

    act(() => {
      useSftpPluginStore.setState({ hostId: 'host-1', path: '/var/www' });
    });

    const sampleFile = new File(['abc'], 'deploy.txt', { type: 'text/plain' });
    await sftpClient.uploadFile(sampleFile);
    expect(seenUrls.some((u) => u.includes('/api/sftp/upload') && u.includes('remotePath=%2Fvar%2Fwww%2Fdeploy.txt'))).toBe(true);

    await sftpClient.download(
      {
        name: 'deploy.txt',
        path: '/var/www/deploy.txt',
        isDir: false,
        isSymlink: false,
        size: 3,
        permissions: '-rw-r--r--',
        mode: 0o644,
        modifiedAt: 0,
      },
      'deploy.txt',
    );
    expect(seenUrls.some((u) => u.includes('/api/sftp/download') && u.includes('remotePath=%2Fvar%2Fwww%2Fdeploy.txt'))).toBe(true);
  });

  it('defaults to localShellEnabled=false in Web App mode, shows SSH gateway guidance, and toggles Allow Local Shell via Settings -> Web App', async () => {
    // 1) Preview mode must NOT expose the Web App settings tab
    shellService.openSettings();
    const { unmount: unmountPreviewSettings } = render(
      <KernelProvider kernel={pluginKernel}>
        <SettingsModal />
      </KernelProvider>,
    );
    const previewNav = within(screen.getByRole('dialog', { name: 'Settings' })).getByRole(
      'navigation',
      { name: 'Settings Navigation' },
    );
    expect(within(previewNav).queryByRole('button', { name: 'Web App' })).toBeNull();
    unmountPreviewSettings();
    shellService.setSettingsModalOpen(false);

    // 2) Web mode defaults to localShellEnabled: false
    setWebBootstrap({
      authRequired: false,
      authenticated: true,
      localShellEnabled: false,
    });

    let serverAllowLocalShell = false;
    const rpcCalls: string[] = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/rpc/')) {
        const cmd = url.split('/api/rpc/')[1];
        rpcCalls.push(cmd);
        switch (cmd) {
          case 'settings_get':
            return new Response(JSON.stringify(useShellStore.getState().settings), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'hosts_list':
          case 'workspaces_list':
          case 'snippets_list':
          case 'history_list':
          case 'plugins_list':
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'plugin_configs_get_all':
            return new Response(JSON.stringify({}), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'web_settings_get':
            return new Response(JSON.stringify({ allowLocalShell: serverAllowLocalShell }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          case 'web_settings_save': {
            const body = JSON.parse(String(init?.body ?? '{}')) as {
              settings?: { allowLocalShell?: boolean };
            };
            serverAllowLocalShell = Boolean(body.settings?.allowLocalShell);
            return new Response(JSON.stringify({ allowLocalShell: serverAllowLocalShell }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          case 'monitor_get_stats':
            return new Response(
              JSON.stringify({
                source: 'local',
                hostname: 'docker-host',
                osName: 'Linux',
                kernelVersion: '6.12',
                arch: 'x86_64',
                uptimeSecs: 100,
                loadAvg: [0.1, 0.1, 0.1],
                cpuUsagePercent: 12.5,
                cpuCores: 4,
                memTotalBytes: 8589934592,
                memUsedBytes: 2147483648,
                swapTotalBytes: 0,
                swapUsedBytes: 0,
                netRxBytesPerSec: 1024,
                netTxBytesPerSec: 512,
                netTotalRxBytes: 10240,
                netTotalTxBytes: 5120,
                disks: [],
                topProcesses: [],
                sampledAt: Date.now(),
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          case 'sync_get_config':
            return new Response(
              JSON.stringify({
                config: {
                  enabled: true,
                  mode: 'gist',
                  apiBaseUrl: 'https://api.github.com',
                  oauthBaseUrl: 'https://github.com',
                  oauthClientId: '',
                  gistId: '',
                  gistFileName: 'lighterm-sync.json',
                  repoOwner: '',
                  repoName: 'lighterm-sync',
                  repoBranch: 'main',
                  repoFilePath: 'lighterm-sync.json',
                  autoCreateTarget: true,
                  autoSyncOnStartup: false,
                  autoSyncOnChange: false,
                  deviceName: 'Web',
                  conflictResolution: 'newest',
                  scopes: {
                    hosts: true,
                    settings: true,
                    workspaces: true,
                    snippets: true,
                    plugins: true,
                    includeHostSecrets: false,
                  },
                },
                isAuthenticated: false,
                account: null,
                oauthScopes: [],
                oauthClientConfigured: true,
                oauthClientIdSource: 'builtin',
                hasPassphrase: false,
                status: {},
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          default:
            return new Response(JSON.stringify(null), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
        }
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(useLayoutStore.getState().leftDrawer.open).toBe(true);
    });

    // No local terminal auto-created, New Local Terminal button is hidden, gateway guidance is visible
    expect(rpcCalls).not.toContain('terminal_create_local');
    expect(screen.queryByLabelText('New Local Terminal')).toBeNull();
    expect(screen.queryByLabelText('Create First Local Shell')).toBeNull();
    expect(screen.getByRole('button', { name: 'Web App Settings' })).toBeTruthy();

    // Open Settings -> Web App directly via button
    fireEvent.click(screen.getByRole('button', { name: 'Web App Settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const checkbox = (await within(dialog).findByLabelText(
      'Allow Local Shell',
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    // Toggle Allow Local Shell on
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(serverAllowLocalShell).toBe(true);
      expect(useWebAuthStore.getState().localShellEnabled).toBe(true);
      expect(checkbox.checked).toBe(true);
    });

    fireEvent.click(within(dialog).getByLabelText('Close Settings'));
    expect(await screen.findByLabelText('Create First Local Shell')).toBeTruthy();
  });
});
