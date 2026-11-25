import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { shellService, useShellStore } from '../core/shellService';
import { harnessKernel } from '../harness/HarnessKernel';
import { resetLightermHarnessForTesting } from '../plugins';
import { SYNC_PLUGIN_ID, syncClient, useSyncPluginStore } from '../plugins/sync';

describe('GitHub Config Sync Plugin (Zero-Config OAuth & Managed Gist)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetLightermHarnessForTesting();
  });

  it('hides storage target and encryption inside collapsed Optional & Advanced Settings, syncs autonomously with a managed Gist via OAuth, and handles logout/disable cleanly', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
      expect(harnessKernel.isPluginActive(SYNC_PLUGIN_ID)).toBe(true);
    });

    // Status bar button opens Settings -> Plugins -> GitHub Sync directly
    fireEvent.click(screen.getByLabelText('GitHub Sync Status'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(dialog.querySelector(`[data-plugin-settings-header="${SYNC_PLUGIN_ID}"]`)).toBeTruthy();

    // Ensure NO manual token input exists, and optional/advanced sections are collapsed by default
    expect(within(dialog).queryByLabelText(/Personal Access Token/i)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Private Repository' })).toBeNull();
    expect(within(dialog).queryByLabelText(/Gist ID/i)).toBeNull();
    expect(within(dialog).queryByLabelText(/Gist File Name/i)).toBeNull();
    expect(within(dialog).queryByLabelText('Encryption Passphrase')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Save Sync Settings' })).toBeNull();
    expect(within(dialog).getByText('Auto-managed Secret Gist')).toBeTruthy();

    const optionalToggle = within(dialog).getByRole('button', {
      name: /Optional & Advanced Settings/i,
    });
    expect(optionalToggle.getAttribute('aria-expanded')).toBe('false');

    // Add an SSH host with password and customize theme on Device A
    await act(async () => {
      await shellService.saveHost({
        id: 'host-prod-1',
        name: 'Prod API 01',
        group: 'Production',
        host: '10.20.30.40',
        port: 2222,
        username: 'deploy',
        auth: { type: 'password', password: 'super-secret-password' },
        defaultPath: '/srv/api',
        startupCommand: null,
        color: '#7aa2f7',
        updatedAt: Date.now(),
      });
      await shellService.updateSettings({ themeId: 'dracula' });
    });

    // Start OAuth Device Flow -> shows one-time code & completes preview authorization
    fireEvent.click(within(dialog).getByRole('button', { name: /Sign in with GitHub/i }));
    const userCodeEl = await within(dialog).findByTestId('oauth-user-code');
    expect(userCodeEl.textContent).toBe('LGTM-2026');

    fireEvent.click(within(dialog).getByRole('button', { name: /Complete Preview Authorization/i }));

    await waitFor(() => {
      expect(useSyncPluginStore.getState().view.isAuthenticated).toBe(true);
      expect(within(dialog).getAllByText(/@github-user/).length).toBeGreaterThan(0);
      expect(within(dialog).getByText('gist')).toBeTruthy();
    });

    // Verify Connection works via OAuth session
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verify Connection' }));
    await waitFor(() => {
      expect(within(dialog).getByText(/Authenticated as @github-user/)).toBeTruthy();
    });

    // Toggling includeHostSecrets without passphrase automatically expands Optional & Advanced Settings
    const includeSecretsCheckbox = within(dialog).getByLabelText(
      /Include SSH passwords, private keys & passphrases/i,
    ) as HTMLInputElement;
    fireEvent.click(includeSecretsCheckbox);

    expect(optionalToggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(dialog).getByLabelText('Encryption Passphrase')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Optional Settings' }));
    await waitFor(() => {
      expect(within(dialog).getByText(/Encryption Passphrase is required/i)).toBeTruthy();
    });

    // Uncheck includeHostSecrets -> auto-saves cleanly and strips password from remote payload
    fireEvent.click(includeSecretsCheckbox);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sync Now' }));

    await waitFor(() => {
      expect(useSyncPluginStore.getState().view.config.gistId).toBeTruthy();
      expect(useSyncPluginStore.getState().view.status.lastStatus).toBe('ok');
    });

    const createdGistId = useSyncPluginStore.getState().view.config.gistId;
    const remoteRaw = window.localStorage.getItem('lighterm:sync:mock-remote') ?? '';
    expect(remoteRaw).toContain('Prod API 01');
    expect(remoteRaw).toContain('[lighterm-managed-sync-v1]');
    expect(remoteRaw).not.toContain('super-secret-password');

    // Simulate Device B: preserve only mock remote, wipe local device config & hosts, reload shell
    const savedRemote = window.localStorage.getItem('lighterm:sync:mock-remote')!;
    window.localStorage.clear();
    window.localStorage.setItem('lighterm:sync:mock-remote', savedRemote);
    syncClient.resetForTesting();

    await act(async () => {
      await shellService.reloadAll();
      await syncClient.loadConfig();
    });
    expect(useShellStore.getState().hosts).toHaveLength(0);
    expect(useShellStore.getState().settings.themeId).toBe('tokyo-night');
    expect(useSyncPluginStore.getState().view.isAuthenticated).toBe(false);

    // Device B authorizes via OAuth -> auto-discovers existing managed Gist & restores hosts/theme live
    await act(async () => {
      const flow = await syncClient.startOAuth(null, false);
      syncClient.approveMockOAuth(flow.flowId);
      const poll = await syncClient.pollOAuth(flow.flowId);
      expect(poll.status).toBe('authorized');
      expect(poll.discoveredGists[0]?.id).toBe(createdGistId);
      await syncClient.syncNow();
    });

    expect(useShellStore.getState().hosts).toHaveLength(1);
    expect(useShellStore.getState().hosts[0].name).toBe('Prod API 01');
    expect(useShellStore.getState().settings.themeId).toBe('dracula');
    expect(await screen.findByText('Prod API 01')).toBeTruthy();

    // Encrypted sync with passphrase restores SSH passwords across devices
    await act(async () => {
      await shellService.saveHost({
        ...useShellStore.getState().hosts[0],
        auth: { type: 'password', password: 'encrypted-ssh-secret' },
        updatedAt: Date.now() + 1000,
      });
      await syncClient.saveConfig({
        config: {
          ...useSyncPluginStore.getState().view.config,
          scopes: {
            ...useSyncPluginStore.getState().view.config.scopes,
            includeHostSecrets: true,
          },
        },
        encryptionPassphrase: 'shared-vault-passphrase',
      });
      await syncClient.push();
    });

    const encryptedRemote = window.localStorage.getItem('lighterm:sync:mock-remote') ?? '';
    expect(encryptedRemote).not.toContain('encrypted-ssh-secret');
    expect(encryptedRemote).not.toContain('Prod API 01');

    // Wrong passphrase fails cleanly, right passphrase restores secret password
    await act(async () => {
      await syncClient.saveConfig({
        config: useSyncPluginStore.getState().view.config,
        encryptionPassphrase: 'wrong-passphrase',
      });
    });
    await expect(syncClient.pull()).rejects.toThrow(/verify your Encryption Passphrase/i);

    await act(async () => {
      await syncClient.saveConfig({
        config: useSyncPluginStore.getState().view.config,
        encryptionPassphrase: 'shared-vault-passphrase',
      });
      await syncClient.pull();
    });
    const restoredHost = useShellStore.getState().hosts[0];
    expect(restoredHost.auth.type).toBe('password');
    if (restoredHost.auth.type === 'password') {
      expect(restoredHost.auth.password).toBe('encrypted-ssh-secret');
    }

    // Sign out clears OAuth session while keeping local hosts intact
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign Out' }));
    await waitFor(() => {
      expect(useSyncPluginStore.getState().view.isAuthenticated).toBe(false);
      expect(within(dialog).getByRole('button', { name: /Sign in with GitHub/i })).toBeTruthy();
    });
    expect(useShellStore.getState().hosts).toHaveLength(1);

    // Disabling lighterm.sync removes statusbar widget; re-enabling restores it
    await act(async () => {
      await harnessKernel.disablePlugin(SYNC_PLUGIN_ID);
    });
    await waitFor(() => {
      expect(harnessKernel.isPluginActive(SYNC_PLUGIN_ID)).toBe(false);
      expect(screen.queryByLabelText('GitHub Sync Status')).toBeNull();
    });

    await act(async () => {
      await harnessKernel.enablePlugin(SYNC_PLUGIN_ID);
    });
    await waitFor(() => {
      expect(harnessKernel.isPluginActive(SYNC_PLUGIN_ID)).toBe(true);
      expect(screen.getByLabelText('GitHub Sync Status')).toBeTruthy();
    });
  }, 15000);

  it('allows switching to Private Repository inside Optional & Advanced Settings, prompts for repo scope, and propagates deletions via tombstones', async () => {
    render(<App />);

    await waitFor(() => {
      expect(useShellStore.getState().initialized).toBe(true);
    });

    fireEvent.click(screen.getByLabelText('GitHub Sync Status'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });

    // First authorize in default Gist mode (only `gist` scope granted)
    await act(async () => {
      const flow = await syncClient.startOAuth(null, false);
      syncClient.approveMockOAuth(flow.flowId);
      await syncClient.pollOAuth(flow.flowId);
    });

    // Expand Optional & Advanced Settings and switch to Private Repository mode
    fireEvent.click(within(dialog).getByRole('button', { name: /Optional & Advanced Settings/i }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Private Repository' }));
    expect(await within(dialog).findByText(/requires re-authorizing with/i)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Authorize Repo Access' }));
    const codeEl = await within(dialog).findByTestId('oauth-user-code');
    expect(codeEl.textContent).toBe('LGTM-2026');
    fireEvent.click(within(dialog).getByRole('button', { name: /Complete Preview Authorization/i }));

    await waitFor(() => {
      expect(useSyncPluginStore.getState().view.oauthScopes).toContain('repo');
    });

    // Save two hosts and sync in Repo mode, then delete one host -> tombstone removes it remotely
    await act(async () => {
      await shellService.saveHost({
        id: 'repo-h1',
        name: 'Repo Host 1',
        group: 'Cloud',
        host: '1.2.3.4',
        port: 22,
        username: 'root',
        auth: { type: 'privateKey', keyPath: '~/.ssh/id_ed25519' },
        updatedAt: 1000,
      });
      await shellService.saveHost({
        id: 'repo-h2',
        name: 'Repo Host 2',
        group: 'Cloud',
        host: '5.6.7.8',
        port: 22,
        username: 'ubuntu',
        auth: { type: 'privateKey', keyPath: '~/.ssh/id_ed25519' },
        updatedAt: 1000,
      });

      await syncClient.saveConfig({
        config: {
          ...useSyncPluginStore.getState().view.config,
          mode: 'repo',
          repoOwner: 'ming',
          repoName: 'my-lighterm-cfg',
          repoBranch: 'main',
          repoFilePath: 'lighterm-sync.json',
          autoCreateTarget: true,
        },
        encryptionPassphrase: null,
      });

      await syncClient.syncNow();
    });

    expect(useSyncPluginStore.getState().lastResult?.repoOwner).toBe('ming');
    expect(useSyncPluginStore.getState().lastResult?.counts.hosts).toBe(2);

    await act(async () => {
      await shellService.deleteHost('repo-h1');
      await syncClient.syncNow();
    });

    expect(useSyncPluginStore.getState().lastResult?.counts.hosts).toBe(1);
    const remoteJson = window.localStorage.getItem('lighterm:sync:mock-remote') ?? '';
    expect(remoteJson).toContain('Repo Host 2');
    expect(remoteJson).not.toContain('Repo Host 1');
  });
});
