import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderGit2,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
  UserCheck,
  XCircle,
} from 'lucide-react';
import { isTauriRuntime } from '../../core/ipc';
import type { PluginSettingsPageProps } from '../../harness';
import {
  createDefaultSyncConfig,
  syncClient,
  useSyncPluginStore,
  type ConflictResolution,
  type GitHubSyncConfig,
  type SyncScopes,
} from './syncClient';

function formatTimestamp(ms?: number | null): string {
  if (!ms) return 'Never';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export const SyncSettingsPage: React.FC<PluginSettingsPageProps> = () => {
  const view = useSyncPluginStore((s) => s.view);
  const loaded = useSyncPluginStore((s) => s.loaded);
  const syncing = useSyncPluginStore((s) => s.syncing);
  const testing = useSyncPluginStore((s) => s.testing);
  const discovering = useSyncPluginStore((s) => s.discovering);
  const oauthStarting = useSyncPluginStore((s) => s.oauthStarting);
  const oauthPolling = useSyncPluginStore((s) => s.oauthPolling);
  const oauthFlow = useSyncPluginStore((s) => s.oauthFlow);
  const oauthStatusMessage = useSyncPluginStore((s) => s.oauthStatusMessage);
  const discoveredGists = useSyncPluginStore((s) => s.discoveredGists);
  const lastTestResult = useSyncPluginStore((s) => s.lastTestResult);
  const storeError = useSyncPluginStore((s) => s.error);

  const [draft, setDraft] = useState<GitHubSyncConfig>(() => view.config);
  const [passphraseInput, setPassphraseInput] = useState('');
  const [clearPassphraseRequested, setClearPassphraseRequested] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);
  const [copiedGist, setCopiedGist] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [pollDelayMs, setPollDelayMs] = useState(5000);

  useEffect(() => {
    if (!loaded) {
      void syncClient.loadConfig().catch(() => {});
    }
  }, [loaded]);

  useEffect(() => {
    setDraft(view.config);
  }, [view.config]);

  useEffect(() => {
    if (oauthFlow) {
      setPollDelayMs(Math.max(1, oauthFlow.interval) * 1000);
    }
  }, [oauthFlow?.flowId, oauthFlow?.interval]);

  // Poll GitHub OAuth Device Flow while waiting for user authorization
  useEffect(() => {
    if (!oauthFlow) return;
    let cancelled = false;
    let timerId: number | null = null;

    const schedule = (delay: number) => {
      timerId = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const res = await syncClient.pollOAuth(oauthFlow.flowId);
          if (cancelled) return;
          if (res.status === 'pending' || res.status === 'slow_down') {
            const nextMs = res.interval
              ? Math.max(1, res.interval) * 1000
              : res.status === 'slow_down'
                ? delay + 5000
                : delay;
            schedule(nextMs);
          }
        } catch {
          // Error surfaced in store
        }
      }, delay);
    };

    schedule(pollDelayMs);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [oauthFlow?.flowId, pollDelayMs]);

  const effectiveHasPassphrase =
    !clearPassphraseRequested && (Boolean(passphraseInput.trim()) || view.hasPassphrase);
  const effectiveOAuthReady =
    view.oauthClientConfigured || Boolean(draft.oauthClientId.trim());

  const persistConfig = async (
    nextConfig: GitHubSyncConfig,
    includePassphraseEdit: boolean,
  ): Promise<boolean> => {
    setSaving(true);
    setLocalMsg(null);
    try {
      await syncClient.saveConfig({
        config: nextConfig,
        encryptionPassphrase: includePassphraseEdit
          ? clearPassphraseRequested
            ? ''
            : passphraseInput.trim()
              ? passphraseInput
              : null
          : null,
      });
      if (includePassphraseEdit) {
        setPassphraseInput('');
        setClearPassphraseRequested(false);
      }
      return true;
    } catch {
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveOptional = async () => {
    const ok = await persistConfig(draft, true);
    if (ok) {
      setLocalMsg('Optional sync settings saved.');
    }
  };

  const handleScopeToggle = async (key: keyof SyncScopes, checked: boolean) => {
    const nextConfig: GitHubSyncConfig = {
      ...draft,
      scopes: {
        ...draft.scopes,
        [key]: checked,
      },
    };
    setDraft(nextConfig);
    setLocalMsg(null);

    if (key === 'includeHostSecrets' && checked && !effectiveHasPassphrase) {
      setAdvancedOpen(true);
      setLocalMsg(
        'Enter an Encryption Passphrase in Optional & Advanced Settings, then click Save Optional Settings.',
      );
      return;
    }

    try {
      await syncClient.saveConfig({ config: nextConfig, encryptionPassphrase: null });
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleAutomationToggle = async (
    key: 'autoSyncOnStartup' | 'autoSyncOnChange',
    checked: boolean,
  ) => {
    const nextConfig: GitHubSyncConfig = {
      ...draft,
      [key]: checked,
    };
    setDraft(nextConfig);
    setLocalMsg(null);
    try {
      await syncClient.saveConfig({ config: nextConfig, encryptionPassphrase: null });
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleStartOAuth = async () => {
    setLocalMsg(null);
    if (!effectiveOAuthReady) {
      setAdvancedOpen(true);
    }
    const ok = await persistConfig(draft, true);
    if (!ok) return;
    try {
      await syncClient.startOAuth(draft, true);
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleLogout = async () => {
    setLocalMsg(null);
    await syncClient.logout();
    setLocalMsg('Signed out from GitHub.');
  };

  const handleTest = async () => {
    setLocalMsg(null);
    try {
      await syncClient.testConnection(draft);
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleDiscoverGists = async () => {
    setLocalMsg(null);
    try {
      await syncClient.discoverGists(draft.apiBaseUrl, draft.gistFileName);
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleSyncAction = async (action: 'sync' | 'push' | 'pull') => {
    const ok = await persistConfig(draft, true);
    if (!ok) return;
    try {
      if (action === 'sync') await syncClient.syncNow();
      else if (action === 'push') await syncClient.push();
      else await syncClient.pull();
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleResetState = async () => {
    setLocalMsg(null);
    try {
      await syncClient.resetLocalState();
      setLocalMsg('Sync tracking state reset. Next sync will compare full state.');
    } catch {
      // Error surfaced via storeError
    }
  };

  const handleCopyCode = async () => {
    if (!oauthFlow?.userCode) return;
    try {
      await navigator.clipboard.writeText(oauthFlow.userCode);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      // Ignore headless clipboard errors
    }
  };

  const handleCopyGistId = async () => {
    if (!draft.gistId.trim()) return;
    try {
      await navigator.clipboard.writeText(draft.gistId.trim());
      setCopiedGist(true);
      window.setTimeout(() => setCopiedGist(false), 1500);
    } catch {
      // Ignore headless clipboard errors
    }
  };

  const status = view.status;
  const accountLogin = view.account?.login ?? status.remoteAccount;
  const missingRepoScope =
    view.isAuthenticated && draft.mode === 'repo' && !view.oauthScopes.includes('repo');
  const targetLabel =
    draft.mode === 'gist'
      ? draft.gistId.trim()
        ? `Managed Secret Gist (${draft.gistId.trim().slice(0, 8)}...)`
        : 'Auto-managed Secret Gist'
      : `Private Repo: ${draft.repoOwner.trim() || accountLogin || '<owner>'}/${draft.repoName} (${draft.repoBranch})`;
  const optionalBadgeLabel =
    draft.mode === 'repo'
      ? 'Private Repo'
      : draft.gistId.trim()
        ? 'Managed Secret Gist'
        : 'Auto Secret Gist';

  return (
    <div className="space-y-4">
      {/* Status & Quick Sync Actions */}
      <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/50 space-y-2.5">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Cloud className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="font-semibold text-[var(--text-primary)]">Sync Status</span>
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  syncing
                    ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                    : status.lastStatus === 'error'
                      ? 'bg-[var(--danger)]/15 text-[var(--danger)]'
                      : status.lastSyncAt
                        ? 'bg-[var(--success)]/15 text-[var(--success)]'
                        : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                }`}
              >
                {syncing
                  ? 'Syncing...'
                  : status.lastStatus === 'error'
                    ? 'Error'
                    : status.lastSyncAt
                      ? 'Synced'
                      : 'Not Synced'}
              </span>
              {accountLogin && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                  @{accountLogin}
                </span>
              )}
              {status.remoteEncrypted && (
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--success)]/15 text-[var(--success)] flex items-center gap-1">
                  <Lock className="w-2.5 h-2.5" />
                  E2EE
                </span>
              )}
            </div>
            <div className="text-[11px] text-[var(--text-muted)] font-mono truncate">
              {targetLabel}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              Last Sync: {formatTimestamp(status.lastSyncAt)}
              {status.lastRemoteDevice ? ` · Device: ${status.lastRemoteDevice}` : ''}
            </div>
            {status.lastMessage && (
              <div className="text-[11px] text-[var(--text-primary)]">{status.lastMessage}</div>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            <button
              type="button"
              disabled={syncing || saving || !view.isAuthenticated}
              onClick={() => void handleSyncAction('sync')}
              className="h-7 px-3 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
            >
              {syncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              Sync Now
            </button>
            <button
              type="button"
              disabled={syncing || saving || !view.isAuthenticated}
              onClick={() => void handleSyncAction('push')}
              title="Overwrite remote GitHub backup with local configuration"
              className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1"
            >
              <Upload className="w-3 h-3" />
              Push
            </button>
            <button
              type="button"
              disabled={syncing || saving || !view.isAuthenticated}
              onClick={() => void handleSyncAction('pull')}
              title="Overwrite local configuration from remote GitHub backup"
              className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1"
            >
              <Download className="w-3 h-3" />
              Pull
            </button>
          </div>
        </div>

        {(storeError || status.lastError) && (
          <div className="p-2 rounded border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)] flex items-center gap-2 text-[11px]">
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 break-words">{storeError ?? status.lastError}</span>
          </div>
        )}

        {localMsg && !storeError && (
          <div className="p-2 rounded border border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)] flex items-center gap-2 text-[11px]">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>{localMsg}</span>
          </div>
        )}
      </div>

      {/* GitHub OAuth Account Card */}
      <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/40 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
            <UserCheck className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>GitHub Account (OAuth)</span>
          </div>
          {view.isAuthenticated && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {view.oauthScopes.map((sc) => (
                <code
                  key={sc}
                  className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] text-[var(--accent)]"
                >
                  {sc}
                </code>
              ))}
            </div>
          )}
        </div>

        {oauthFlow ? (
          <div
            data-oauth-device-flow="active"
            className="p-3 rounded-md border border-[var(--accent)]/40 bg-[var(--accent)]/10 space-y-2.5"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-[11px] text-[var(--text-primary)] font-medium">
                Enter this one-time code on GitHub to authorize Lighterm:
              </span>
              <span className="text-[10px] font-mono text-[var(--text-muted)]">
                Scopes: {oauthFlow.scopes.join(', ')}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <code
                data-testid="oauth-user-code"
                className="px-3 py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] font-mono text-base font-bold tracking-widest text-[var(--accent)]"
              >
                {oauthFlow.userCode}
              </code>

              <button
                type="button"
                onClick={() => void handleCopyCode()}
                className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
              >
                {copiedCode ? (
                  <Check className="w-3.5 h-3.5 text-[var(--success)]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedCode ? 'Copied' : 'Copy Code'}</span>
              </button>

              <button
                type="button"
                onClick={() => void syncClient.openVerificationUrl(oauthFlow.verificationUri)}
                className="h-8 px-3 rounded-md bg-[var(--accent)] text-[#0f111a] font-medium hover:opacity-90 flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open GitHub Authorization Page</span>
              </button>
            </div>

            <div className="text-[11px] text-[var(--text-muted)] font-mono truncate">
              {oauthFlow.verificationUri}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1 flex-wrap">
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                {oauthPolling && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />}
                <span>{oauthStatusMessage ?? 'Waiting for GitHub authorization...'}</span>
              </div>

              <div className="flex items-center gap-2">
                {!isTauriRuntime() && (
                  <button
                    type="button"
                    onClick={() => {
                      syncClient.approveMockOAuth(oauthFlow.flowId);
                      void syncClient.pollOAuth(oauthFlow.flowId);
                    }}
                    className="h-7 px-2.5 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/15 text-[var(--success)] hover:bg-[var(--success)]/25"
                  >
                    Complete Preview Authorization
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void syncClient.cancelOAuth(oauthFlow.flowId)}
                  className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : view.isAuthenticated ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[11px] text-[var(--text-primary)]">
                Signed in as <strong className="font-mono">@{accountLogin}</strong>
                {view.account?.name ? ` (${view.account.name})` : ''}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  disabled={testing}
                  onClick={() => void handleTest()}
                  className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1"
                >
                  {testing && <Loader2 className="w-3 h-3 animate-spin" />}
                  Verify Connection
                </button>
                <button
                  type="button"
                  disabled={oauthStarting}
                  onClick={() => void handleStartOAuth()}
                  className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1"
                >
                  <LogIn className="w-3 h-3" />
                  Re-authorize
                </button>
                <button
                  type="button"
                  onClick={() => void handleLogout()}
                  className="h-7 px-2.5 rounded-md border border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/15 flex items-center gap-1"
                >
                  <LogOut className="w-3 h-3" />
                  Sign Out
                </button>
              </div>
            </div>

            {missingRepoScope && (
              <div className="p-2 rounded border border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)] flex items-center justify-between gap-2 text-[11px]">
                <span>
                  Current authorization only includes <code>gist</code> scope. Private Repository
                  sync requires re-authorizing with <code>repo</code> access.
                </span>
                <button
                  type="button"
                  onClick={() => void handleStartOAuth()}
                  className="h-6 px-2 rounded border border-[var(--warning)]/50 font-medium shrink-0 hover:bg-[var(--warning)]/20"
                >
                  Authorize Repo Access
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-[var(--text-muted)]">
              Authorize Lighterm with your GitHub account via OAuth. Sync automatically uses a
              managed Secret Gist in your account — zero manual configuration needed.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={oauthStarting || saving}
                onClick={() => void handleStartOAuth()}
                className="h-8 px-3.5 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
              >
                {oauthStarting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <LogIn className="w-3.5 h-3.5" />
                )}
                Sign in with GitHub
              </button>
              {!effectiveOAuthReady && (
                <span className="text-[11px] text-[var(--warning)]">
                  Configure a GitHub OAuth Client ID in Optional &amp; Advanced Settings (or{' '}
                  <code>LIGHTERM_GITHUB_CLIENT_ID</code>) to authorize.
                </span>
              )}
            </div>
          </div>
        )}

        {lastTestResult && (
          <div
            className={`p-2.5 rounded-md border flex items-center gap-2 text-[11px] ${
              lastTestResult.isPublicTarget
                ? 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]'
                : lastTestResult.success
                  ? 'border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]'
                  : 'border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]'
            }`}
          >
            {lastTestResult.isPublicTarget ? (
              <AlertTriangle className="w-4 h-4 shrink-0" />
            ) : lastTestResult.success ? (
              <CheckCircle2 className="w-4 h-4 shrink-0" />
            ) : (
              <XCircle className="w-4 h-4 shrink-0" />
            )}
            <span className="flex-1">{lastTestResult.message}</span>
          </div>
        )}
      </div>

      {/* Sync Scopes */}
      <div className="space-y-2">
        <span className="font-semibold text-[var(--text-primary)] block">What to Sync</span>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ['hosts', 'SSH Hosts'],
              ['settings', 'App Settings & Shortcuts'],
              ['workspaces', 'Saved Workspaces'],
              ['snippets', 'Command Snippets'],
              ['plugins', 'Plugin States & Settings'],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center gap-2 p-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/40 text-[var(--text-primary)] cursor-pointer"
            >
              <input
                type="checkbox"
                checked={draft.scopes[key]}
                onChange={(e) => void handleScopeToggle(key, e.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <label className="flex items-start gap-2 p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/40 text-[var(--text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={draft.scopes.includeHostSecrets}
            onChange={(e) => void handleScopeToggle('includeHostSecrets', e.target.checked)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium block">
              Include SSH passwords, private keys &amp; passphrases
            </span>
            <span className="text-[11px] text-[var(--text-muted)] block">
              Requires an Encryption Passphrase (configured under Optional &amp; Advanced Settings).
              When unchecked, host connection metadata syncs without sensitive credentials.
            </span>
            {draft.scopes.includeHostSecrets && !effectiveHasPassphrase && (
              <span className="text-[11px] text-[var(--warning)] block mt-0.5">
                Please set an Encryption Passphrase below before saving or syncing host secrets.
              </span>
            )}
          </span>
        </label>
      </div>

      {/* Automation */}
      <div className="space-y-2">
        <span className="font-semibold text-[var(--text-primary)] block">Automation</span>
        <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={draft.autoSyncOnStartup}
            onChange={(e) => void handleAutomationToggle('autoSyncOnStartup', e.target.checked)}
          />
          <span>Automatically sync on application startup</span>
        </label>
        <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
          <input
            type="checkbox"
            checked={draft.autoSyncOnChange}
            onChange={(e) => void handleAutomationToggle('autoSyncOnChange', e.target.checked)}
          />
          <span>Automatically sync after local hosts, workspaces, snippets, or settings change</span>
        </label>
      </div>

      {/* Optional & Advanced Settings (Default Collapsed) */}
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/30 overflow-hidden">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
          className="w-full px-3 py-2.5 flex items-center justify-between gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50"
        >
          <span className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="font-semibold">Optional &amp; Advanced Settings</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-elevated)] text-[var(--text-muted)]">
              {optionalBadgeLabel}
            </span>
            {view.hasPassphrase && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--success)]/15 text-[var(--success)] flex items-center gap-1">
                <Lock className="w-2.5 h-2.5" />
                Encrypted
              </span>
            )}
          </span>
          <ChevronDown
            className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${
              advancedOpen ? '' : '-rotate-90'
            }`}
          />
        </button>

        {advancedOpen && (
          <div className="p-3 border-t border-[var(--border-subtle)] space-y-4">
            {/* End-to-End Encryption */}
            <div className="p-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/40 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                  <KeyRound className="w-3.5 h-3.5 text-[var(--accent)]" />
                  <span>End-to-End Encryption (Optional / Required for SSH Secrets)</span>
                </div>
                {view.hasPassphrase && !clearPassphraseRequested && (
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-[var(--success)] flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" />
                      AES-256-GCM Active
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPassphraseInput('');
                        setClearPassphraseRequested(true);
                      }}
                      className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                    >
                      Clear Passphrase
                    </button>
                  </div>
                )}
              </div>
              <div className="relative">
                <input
                  id="sync-encryption-passphrase"
                  type={showPassphrase ? 'text' : 'password'}
                  aria-label="Encryption Passphrase"
                  value={passphraseInput}
                  onChange={(e) => {
                    setPassphraseInput(e.target.value);
                    setClearPassphraseRequested(false);
                  }}
                  placeholder={
                    view.hasPassphrase && !clearPassphraseRequested
                      ? 'Passphrase saved locally (enter new one to change)...'
                      : 'Enter shared passphrase used across your devices...'
                  }
                  className="w-full h-8 pl-2.5 pr-8 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  aria-label={showPassphrase ? 'Hide Passphrase' : 'Show Passphrase'}
                  onClick={() => setShowPassphrase((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {showPassphrase ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                </button>
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                Stored only locally in restricted device credentials. Remote sync payloads are
                encrypted with PBKDF2-SHA256 + AES-256-GCM before leaving this computer.
              </p>
            </div>

            {/* Storage Target Override */}
            <div className="space-y-3">
              <div>
                <span className="font-semibold text-[var(--text-primary)] block mb-1.5">
                  Storage Target
                </span>
                <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[var(--bg-app)] border border-[var(--border-subtle)]">
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, mode: 'gist' }))}
                    className={`h-7 rounded-md font-medium flex items-center justify-center gap-1.5 transition-colors ${
                      draft.mode === 'gist'
                        ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <Cloud className="w-3.5 h-3.5" />
                    Secret Gist (Auto-managed)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, mode: 'repo' }))}
                    className={`h-7 rounded-md font-medium flex items-center justify-center gap-1.5 transition-colors ${
                      draft.mode === 'repo'
                        ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    <FolderGit2 className="w-3.5 h-3.5" />
                    Private Repository
                  </button>
                </div>
              </div>

              {draft.mode === 'gist' ? (
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-7">
                    <label
                      htmlFor="sync-gist-id"
                      className="font-semibold text-[var(--text-primary)] block mb-1"
                    >
                      Gist ID (optional override)
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        id="sync-gist-id"
                        type="text"
                        value={draft.gistId}
                        onChange={(e) => setDraft((d) => ({ ...d, gistId: e.target.value }))}
                        placeholder="Auto-managed by Lighterm"
                        className="flex-1 h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                      {draft.gistId.trim() && (
                        <button
                          type="button"
                          onClick={() => void handleCopyGistId()}
                          title="Copy Gist ID"
                          aria-label="Copy Gist ID"
                          className="h-8 px-2 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          {copiedGist ? (
                            <Check className="w-3.5 h-3.5 text-[var(--success)]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={discovering || !view.isAuthenticated}
                        onClick={() => void handleDiscoverGists()}
                        className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1 shrink-0"
                      >
                        {discovering ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Search className="w-3.5 h-3.5" />
                        )}
                        Detect Gists
                      </button>
                    </div>
                  </div>

                  <div className="col-span-5">
                    <label
                      htmlFor="sync-gist-file"
                      className="font-semibold text-[var(--text-primary)] block mb-1"
                    >
                      Gist File Name
                    </label>
                    <input
                      id="sync-gist-file"
                      type="text"
                      value={draft.gistFileName}
                      onChange={(e) => setDraft((d) => ({ ...d, gistFileName: e.target.value }))}
                      placeholder="lighterm-sync.json"
                      className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                    />
                  </div>

                  {discoveredGists.length > 0 && (
                    <div className="col-span-12 p-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-app)]/60 space-y-1.5">
                      <div className="text-[11px] font-semibold text-[var(--text-primary)]">
                        Detected Lighterm Gists (click to select):
                      </div>
                      <div className="space-y-1">
                        {discoveredGists.map((g) => (
                          <button
                            key={g.id}
                            type="button"
                            onClick={() =>
                              setDraft((d) => ({
                                ...d,
                                gistId: g.id,
                                gistFileName: g.fileName || d.gistFileName,
                              }))
                            }
                            className={`w-full px-2.5 py-1.5 rounded border text-left flex items-center justify-between gap-2 transition-colors ${
                              draft.gistId === g.id
                                ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text-primary)]'
                                : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                            }`}
                          >
                            <span className="font-mono text-[11px] truncate">
                              {g.id} · {g.fileName}
                            </span>
                            <span className="text-[10px] shrink-0">
                              {g.public ? 'Public' : 'Secret'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2.5">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="font-semibold text-[var(--text-primary)] block mb-1">
                        Repository Owner (optional)
                      </span>
                      <input
                        type="text"
                        aria-label="Repository Owner"
                        value={draft.repoOwner}
                        onChange={(e) => setDraft((d) => ({ ...d, repoOwner: e.target.value }))}
                        placeholder="Auto-detect from GitHub account"
                        className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                    <label className="block">
                      <span className="font-semibold text-[var(--text-primary)] block mb-1">
                        Repository Name
                      </span>
                      <input
                        type="text"
                        aria-label="Repository Name"
                        value={draft.repoName}
                        onChange={(e) => setDraft((d) => ({ ...d, repoName: e.target.value }))}
                        placeholder="lighterm-sync"
                        className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="font-semibold text-[var(--text-primary)] block mb-1">
                        Branch
                      </span>
                      <input
                        type="text"
                        aria-label="Repository Branch"
                        value={draft.repoBranch}
                        onChange={(e) => setDraft((d) => ({ ...d, repoBranch: e.target.value }))}
                        placeholder="main"
                        className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                    <label className="block">
                      <span className="font-semibold text-[var(--text-primary)] block mb-1">
                        File Path
                      </span>
                      <input
                        type="text"
                        aria-label="Repository File Path"
                        value={draft.repoFilePath}
                        onChange={(e) => setDraft((d) => ({ ...d, repoFilePath: e.target.value }))}
                        placeholder="lighterm-sync.json"
                        className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                    </label>
                  </div>
                  <label className="flex items-center gap-2 text-[var(--text-primary)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.autoCreateTarget}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, autoCreateTarget: e.target.checked }))
                      }
                    />
                    <span>Auto-create private repository if it does not exist</span>
                  </label>
                </div>
              )}
            </div>

            {/* OAuth & Advanced Parameters */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label
                  htmlFor="sync-oauth-client-id"
                  className="font-semibold text-[var(--text-primary)]"
                >
                  OAuth App Client ID (optional override)
                </label>
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                  Source: {view.oauthClientIdSource}
                </span>
              </div>
              <input
                id="sync-oauth-client-id"
                type="text"
                value={draft.oauthClientId}
                onChange={(e) => setDraft((d) => ({ ...d, oauthClientId: e.target.value }))}
                placeholder="Leave empty to use built-in Lighterm OAuth App"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
              />
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Lighterm includes a built-in GitHub OAuth Client ID out of the box. Only set an
                override here (or via <code>LIGHTERM_GITHUB_CLIENT_ID</code>) if you want to use a
                custom OAuth App or GitHub Enterprise Server.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-semibold text-[var(--text-primary)] block mb-1">
                  GitHub OAuth Base URL
                </span>
                <input
                  type="text"
                  aria-label="GitHub OAuth Base URL"
                  value={draft.oauthBaseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, oauthBaseUrl: e.target.value }))}
                  placeholder="https://github.com"
                  className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                />
              </label>

              <label className="block">
                <span className="font-semibold text-[var(--text-primary)] block mb-1">
                  GitHub API Base URL
                </span>
                <input
                  type="text"
                  aria-label="GitHub API Base URL"
                  value={draft.apiBaseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, apiBaseUrl: e.target.value }))}
                  placeholder="https://api.github.com"
                  className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="font-semibold text-[var(--text-primary)] block mb-1">
                  Device Name
                </span>
                <input
                  type="text"
                  aria-label="Device Name"
                  value={draft.deviceName}
                  onChange={(e) => setDraft((d) => ({ ...d, deviceName: e.target.value }))}
                  placeholder="My Laptop"
                  className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </label>

              <label className="block">
                <span className="font-semibold text-[var(--text-primary)] block mb-1">
                  Conflict Resolution
                </span>
                <select
                  aria-label="Conflict Resolution"
                  value={draft.conflictResolution}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      conflictResolution: e.target.value as ConflictResolution,
                    }))
                  }
                  className="w-full h-8 px-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                >
                  <option value="newest">Newest Wins (updatedAt)</option>
                  <option value="local">Prefer Local on Conflict</option>
                  <option value="remote">Prefer Remote on Conflict</option>
                </select>
              </label>
            </div>

            <div className="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2 flex-wrap">
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleSaveOptional()}
                className="h-8 px-3 rounded-md bg-[var(--accent)] text-[#0f111a] font-medium hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
              >
                {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                Save Optional Settings
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleResetState()}
                  className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" />
                  Reset Sync State
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(createDefaultSyncConfig())}
                  className="h-8 px-2.5 rounded-md border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]"
                >
                  Restore Defaults
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
