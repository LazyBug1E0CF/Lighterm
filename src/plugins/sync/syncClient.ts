import { create } from 'zustand';
import { invokeTauri, isTauriRuntime, makeUuid, readLs, writeLs } from '../../core/ipc';
import { createDefaultSettings, shellService } from '../../core/shellService';
import { pluginKernel } from '../../kernel/PluginKernel';
import type { AppSettings, HostConfig, SavedWorkspace, Snippet } from '../../types';
import { base64ToBytes, utf8ToBase64 } from '../../utils/base64';

export const SYNC_PLUGIN_ID = 'lighterm.sync';

export type SyncTargetMode = 'gist' | 'repo';
export type ConflictResolution = 'newest' | 'local' | 'remote';

export interface SyncScopes {
  hosts: boolean;
  settings: boolean;
  workspaces: boolean;
  snippets: boolean;
  plugins: boolean;
  includeHostSecrets: boolean;
}

export interface GitHubSyncConfig {
  enabled: boolean;
  mode: SyncTargetMode;
  apiBaseUrl: string;
  oauthBaseUrl: string;
  oauthClientId: string;
  gistId: string;
  gistFileName: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  repoFilePath: string;
  autoCreateTarget: boolean;
  autoSyncOnStartup: boolean;
  autoSyncOnChange: boolean;
  deviceName: string;
  conflictResolution: ConflictResolution;
  scopes: SyncScopes;
}

export interface SyncStatusState {
  lastSyncAt?: number | null;
  lastAction?: string | null;
  lastStatus?: string | null;
  lastMessage?: string | null;
  lastError?: string | null;
  lastRemoteUpdatedAt?: number | null;
  lastRemoteDevice?: string | null;
  remoteAccount?: string | null;
  remoteUrl?: string | null;
  remoteEncrypted?: boolean | null;
}

export interface SyncAccountInfo {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface SyncConfigView {
  config: GitHubSyncConfig;
  isAuthenticated: boolean;
  account?: SyncAccountInfo | null;
  oauthScopes: string[];
  oauthClientConfigured: boolean;
  oauthClientIdSource: 'custom' | 'env' | 'builtin' | 'none' | string;
  hasPassphrase: boolean;
  status: SyncStatusState;
}

export interface SyncConfigUpdateInput {
  config: GitHubSyncConfig;
  encryptionPassphrase?: string | null;
}

export interface OAuthDeviceFlowStart {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  scopes: string[];
  browserOpened: boolean;
}

export interface DiscoveredGist {
  id: string;
  description: string;
  fileName: string;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
}

export interface OAuthPollResult {
  status: 'pending' | 'slow_down' | 'authorized' | 'expired' | 'denied' | 'error' | string;
  interval?: number | null;
  message?: string | null;
  view?: SyncConfigView | null;
  discoveredGists: DiscoveredGist[];
}

export interface SyncTestResult {
  success: boolean;
  username?: string | null;
  targetExists: boolean;
  targetUrl?: string | null;
  isPublicTarget: boolean;
  discoveredGists: DiscoveredGist[];
  message: string;
}

export interface SyncCounts {
  hosts: number;
  workspaces: number;
  snippets: number;
  settingsUpdated: boolean;
  pluginsUpdated: boolean;
}

export interface SyncOperationResult {
  action: string;
  appliedLocal: boolean;
  pushedRemote: boolean;
  encrypted: boolean;
  remoteUrl?: string | null;
  gistId?: string | null;
  repoOwner?: string | null;
  remoteUpdatedAt?: number | null;
  summary: string;
  counts: SyncCounts;
  status: SyncStatusState;
  invalidatedHostIds: string[];
  updatedPluginStates: Record<string, boolean>;
}

export function createDefaultSyncConfig(): GitHubSyncConfig {
  return {
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
    deviceName: 'Lighterm Browser',
    conflictResolution: 'newest',
    scopes: {
      hosts: true,
      settings: true,
      workspaces: true,
      snippets: true,
      plugins: true,
      includeHostSecrets: false,
    },
  };
}

function createInitialView(): SyncConfigView {
  return {
    config: createDefaultSyncConfig(),
    isAuthenticated: false,
    account: null,
    oauthScopes: [],
    oauthClientConfigured: true,
    oauthClientIdSource: 'builtin',
    hasPassphrase: false,
    status: {},
  };
}

export interface SyncStoreState {
  view: SyncConfigView;
  loaded: boolean;
  syncing: boolean;
  testing: boolean;
  discovering: boolean;
  oauthStarting: boolean;
  oauthPolling: boolean;
  oauthFlow: OAuthDeviceFlowStart | null;
  oauthStatusMessage: string | null;
  discoveredGists: DiscoveredGist[];
  lastTestResult: SyncTestResult | null;
  lastResult: SyncOperationResult | null;
  error: string | null;
}

export const useSyncPluginStore = create<SyncStoreState>(() => ({
  view: createInitialView(),
  loaded: false,
  syncing: false,
  testing: false,
  discovering: false,
  oauthStarting: false,
  oauthPolling: false,
  oauthFlow: null,
  oauthStatusMessage: null,
  discoveredGists: [],
  lastTestResult: null,
  lastResult: null,
  error: null,
}));

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

// ---- Browser / Vitest LocalStorage Fallback Simulation ----

const LS_SYNC_CONFIG = 'lighterm:sync:config';
const LS_SYNC_CREDS = 'lighterm:sync:credentials';
const LS_SYNC_STATE = 'lighterm:sync:state';
const LS_SYNC_MOCK_REMOTE = 'lighterm:sync:mock-remote';
const LS_HOSTS = 'lighterm:hosts';
const LS_SETTINGS = 'lighterm:settings';
const LS_WORKSPACES = 'lighterm:workspaces';
const LS_SNIPPETS = 'lighterm:snippets';
const LS_ENABLED_PLUGINS = 'lighterm:enabled-plugins';
const LS_PLUGIN_CONFIG_PREFIX = 'lighterm:plugin-config:';
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

interface MockCredentials {
  accessToken: string;
  scopes: string[];
  accountLogin: string | null;
  accountName: string | null;
  accountAvatarUrl: string | null;
  encryptionPassphrase: string;
}

interface MockOAuthFlowEntry {
  flowId: string;
  scopes: string[];
  mode: SyncTargetMode;
  gistFileName: string;
  status: 'pending' | 'authorized' | 'denied' | 'expired';
}

const mockPendingFlows = new Map<string, MockOAuthFlowEntry>();

interface MockTombstones {
  hosts: Record<string, number>;
  workspaces: Record<string, number>;
  snippets: Record<string, number>;
}

interface MockSyncLocalState {
  status: SyncStatusState;
  lastSyncedHostIds: string[];
  lastSyncedWorkspaceIds: string[];
  lastSyncedSnippetIds: string[];
  lastSettingsHash: string | null;
  lastPluginsHash: string | null;
  localTombstones: MockTombstones;
}

interface MockSyncPayload {
  hosts?: HostConfig[];
  hostsIncludeSecrets: boolean;
  settings?: AppSettings;
  workspaces?: SavedWorkspace[];
  snippets?: Snippet[];
  pluginStates?: Record<string, boolean>;
  pluginConfigs?: Record<string, Record<string, unknown>>;
  tombstones: MockTombstones;
}

interface MockSyncEnvelope {
  format: 'lighterm-sync';
  version: number;
  encrypted: boolean;
  updatedAt: number;
  deviceName: string;
  payload?: MockSyncPayload;
  encryption?: {
    kdf: string;
    iterations: number;
    cipher: string;
    passphraseHash: string;
    ciphertext: string;
  };
}

interface MockGistRecord {
  id: string;
  description: string;
  public: boolean;
  updatedAt: string;
  htmlUrl: string;
  files: Record<string, string>;
}

interface MockRepoRecord {
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  files: Record<string, string>;
}

interface MockRemoteStore {
  gists: Record<string, MockGistRecord>;
  repos: Record<string, MockRepoRecord>;
}

function simpleHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

function canonicalStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

function canonicalHash(val: unknown): string {
  return simpleHash(canonicalStringify(val));
}

function stripHostSecrets(host: HostConfig): HostConfig {
  if (host.auth.type === 'password') {
    return { ...host, auth: { type: 'password', password: null } };
  }
  return {
    ...host,
    auth: {
      type: 'privateKey',
      keyPath: host.auth.keyPath ?? null,
      privateKeyPem: null,
      passphrase: null,
    },
  };
}

function hostHasSecrets(host: HostConfig): boolean {
  if (host.auth.type === 'password') {
    return Boolean(host.auth.password);
  }
  return Boolean(host.auth.privateKeyPem?.trim() || host.auth.passphrase);
}

function preserveLocalSecrets(incoming: HostConfig, local?: HostConfig): HostConfig {
  if (!local || hostHasSecrets(incoming)) return incoming;
  if (incoming.auth.type === 'password' && local.auth.type === 'password') {
    return { ...incoming, auth: { type: 'password', password: local.auth.password ?? null } };
  }
  if (incoming.auth.type === 'privateKey' && local.auth.type === 'privateKey') {
    return {
      ...incoming,
      auth: {
        type: 'privateKey',
        keyPath: incoming.auth.keyPath ?? null,
        privateKeyPem: local.auth.privateKeyPem ?? null,
        passphrase: local.auth.passphrase ?? null,
      },
    };
  }
  return incoming;
}

function readMockConfig(): GitHubSyncConfig {
  const defaults = createDefaultSyncConfig();
  const stored = readLs<Partial<GitHubSyncConfig>>(LS_SYNC_CONFIG, () => defaults);
  return {
    ...defaults,
    ...stored,
    scopes: { ...defaults.scopes, ...(stored.scopes ?? {}) },
  };
}

function readMockCreds(): MockCredentials {
  return readLs<MockCredentials>(LS_SYNC_CREDS, () => ({
    accessToken: '',
    scopes: [],
    accountLogin: null,
    accountName: null,
    accountAvatarUrl: null,
    encryptionPassphrase: '',
  }));
}

function readMockState(): MockSyncLocalState {
  const defaults: MockSyncLocalState = {
    status: {},
    lastSyncedHostIds: [],
    lastSyncedWorkspaceIds: [],
    lastSyncedSnippetIds: [],
    lastSettingsHash: null,
    lastPluginsHash: null,
    localTombstones: { hosts: {}, workspaces: {}, snippets: {} },
  };
  const stored = readLs<Partial<MockSyncLocalState>>(LS_SYNC_STATE, () => defaults);
  return {
    ...defaults,
    ...stored,
    status: { ...(stored.status ?? {}) },
    localTombstones: {
      hosts: { ...(stored.localTombstones?.hosts ?? {}) },
      workspaces: { ...(stored.localTombstones?.workspaces ?? {}) },
      snippets: { ...(stored.localTombstones?.snippets ?? {}) },
    },
  };
}

function readMockRemote(): MockRemoteStore {
  return readLs<MockRemoteStore>(LS_SYNC_MOCK_REMOTE, () => ({ gists: {}, repos: {} }));
}

function getMockView(): SyncConfigView {
  const config = readMockConfig();
  const creds = readMockCreds();
  const state = readMockState();
  const isAuthenticated = Boolean(creds.accessToken.trim());
  return {
    config,
    isAuthenticated,
    account: isAuthenticated
      ? {
          login: creds.accountLogin || state.status.remoteAccount || 'github-user',
          name: creds.accountName,
          avatarUrl: creds.accountAvatarUrl,
        }
      : null,
    oauthScopes: isAuthenticated ? creds.scopes : [],
    oauthClientConfigured: true,
    oauthClientIdSource: config.oauthClientId.trim() ? 'custom' : 'builtin',
    hasPassphrase: Boolean(creds.encryptionPassphrase.trim()),
    status: state.status,
  };
}

function readAllLocalPluginConfigs(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (typeof window === 'undefined' || !window.localStorage) return out;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k || !k.startsWith(LS_PLUGIN_CONFIG_PREFIX)) continue;
    const pluginId = k.slice(LS_PLUGIN_CONFIG_PREFIX.length);
    if (pluginId === SYNC_PLUGIN_ID) continue;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(k) ?? 'null') as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out[pluginId] = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore malformed config
    }
  }
  return out;
}

function writeAllLocalPluginConfigs(configs: Record<string, Record<string, unknown>>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const toRemove: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k && k.startsWith(LS_PLUGIN_CONFIG_PREFIX)) {
      const pid = k.slice(LS_PLUGIN_CONFIG_PREFIX.length);
      if (pid !== SYNC_PLUGIN_ID) toRemove.push(k);
    }
  }
  for (const k of toRemove) {
    window.localStorage.removeItem(k);
  }
  for (const [pid, cfg] of Object.entries(configs)) {
    if (pid === SYNC_PLUGIN_ID) continue;
    window.localStorage.setItem(`${LS_PLUGIN_CONFIG_PREFIX}${pid}`, JSON.stringify(cfg));
  }
}

function pruneTombstones(map: Record<string, number>, nowMs: number): Record<string, number> {
  const cutoff = nowMs - TOMBSTONE_RETENTION_MS;
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(map)) {
    if (ts >= cutoff) out[id] = ts;
  }
  return out;
}

function collectDeletions(
  lastIds: string[],
  currentIds: Set<string>,
  tombstones: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const next = { ...tombstones };
  for (const id of lastIds) {
    if (!currentIds.has(id) && !(id in next)) {
      next[id] = nowMs;
    }
  }
  return pruneTombstones(next, nowMs);
}

function mergeTombstones(
  local: Record<string, number>,
  remote: Record<string, number>,
  nowMs: number,
): Record<string, number> {
  const merged = { ...local };
  for (const [id, ts] of Object.entries(remote)) {
    if (!(id in merged) || ts > merged[id]) {
      merged[id] = ts;
    }
  }
  return pruneTombstones(merged, nowMs);
}

function mergeEntities<T extends { id: string; updatedAt: number }>(
  local: T[],
  remote: T[],
  tombstones: Record<string, number>,
  resolution: ConflictResolution,
): T[] {
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const item of [...local, ...remote]) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      orderedIds.push(item.id);
    }
  }

  const pick = (li: T, ri: T): T => {
    if (resolution === 'local') return li;
    if (resolution === 'remote') return ri;
    return ri.updatedAt > li.updatedAt ? ri : li;
  };

  const result: T[] = [];
  for (const id of orderedIds) {
    const li = localMap.get(id);
    const ri = remoteMap.get(id);
    const tombTs = tombstones[id];

    if (li && ri) {
      if (tombTs !== undefined && tombTs > Math.max(li.updatedAt, ri.updatedAt)) {
        continue;
      }
      delete tombstones[id];
      result.push(pick(li, ri));
    } else if (li) {
      if (tombTs !== undefined && tombTs >= li.updatedAt) {
        continue;
      }
      delete tombstones[id];
      result.push(li);
    } else if (ri) {
      if (tombTs !== undefined && tombTs >= ri.updatedAt) {
        continue;
      }
      delete tombstones[id];
      result.push(ri);
    }
  }
  return result;
}

function mockEncryptPayload(
  payload: MockSyncPayload,
  passphrase: string,
): MockSyncEnvelope['encryption'] {
  const json = JSON.stringify(payload);
  return {
    kdf: 'pbkdf2-hmac-sha256',
    iterations: 100000,
    cipher: 'aes-256-gcm',
    passphraseHash: simpleHash(`lighterm-sync-v1:${passphrase}`),
    ciphertext: utf8ToBase64(json),
  };
}

function mockDecryptPayload(
  enc: NonNullable<MockSyncEnvelope['encryption']>,
  passphrase: string,
): MockSyncPayload {
  if (!passphrase.trim()) {
    throw new Error(
      'Remote sync data is encrypted. Please enter your Encryption Passphrase in GitHub Sync settings.',
    );
  }
  const expectedHash = simpleHash(`lighterm-sync-v1:${passphrase}`);
  if (enc.passphraseHash !== expectedHash) {
    throw new Error(
      'Failed to decrypt remote sync data. Please verify your Encryption Passphrase.',
    );
  }
  const bytes = base64ToBytes(enc.ciphertext);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as MockSyncPayload;
}

const MANAGED_GIST_DESCRIPTION = 'Lighterm Config Sync [lighterm-managed-sync-v1]';

function discoverMockGists(remote: MockRemoteStore, fileName: string): DiscoveredGist[] {
  const target = fileName.trim() || 'lighterm-sync.json';
  return Object.values(remote.gists)
    .filter(
      (g) =>
        target in g.files ||
        'lighterm-sync.json' in g.files ||
        g.description.includes('Lighterm Config Sync'),
    )
    .map((g) => ({
      id: g.id,
      description: g.description,
      fileName: target in g.files ? target : 'lighterm-sync.json',
      public: g.public,
      updatedAt: g.updatedAt,
      htmlUrl: g.htmlUrl,
    }))
    .sort((a, b) => {
      const aSecret = Number(!a.public);
      const bSecret = Number(!b.public);
      if (aSecret !== bSecret) return bSecret - aSecret;
      const aManaged = Number(a.description.includes('[lighterm-managed-sync-v1]'));
      const bManaged = Number(b.description.includes('[lighterm-managed-sync-v1]'));
      if (aManaged !== bManaged) return bManaged - aManaged;
      const aTarget = Number(a.fileName === target);
      const bTarget = Number(b.fileName === target);
      if (aTarget !== bTarget) return bTarget - aTarget;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

function runMockSyncOperation(action: 'sync' | 'push' | 'pull'): SyncOperationResult {
  const config = readMockConfig();
  const creds = readMockCreds();
  const state = readMockState();
  const remote = readMockRemote();
  const nowMs = Date.now();

  if (!creds.accessToken.trim()) {
    throw new Error('Not signed in to GitHub. Please sign in with GitHub OAuth first.');
  }
  if (
    (action === 'push' || action === 'sync') &&
    config.scopes.includeHostSecrets &&
    !creds.encryptionPassphrase.trim()
  ) {
    throw new Error(
      'An Encryption Passphrase is required when syncing SSH passwords, private keys, or passphrases.',
    );
  }

  const localHosts = readLs<HostConfig[]>(LS_HOSTS, () => []);
  const localSettings = readLs<AppSettings>(LS_SETTINGS, createDefaultSettings);
  const localWorkspaces = readLs<SavedWorkspace[]>(LS_WORKSPACES, () => []);
  const localSnippets = readLs<Snippet[]>(LS_SNIPPETS, () => []);
  const localPluginStates = readLs<Record<string, boolean>>(LS_ENABLED_PLUGINS, () => ({}));
  const localPluginConfigs = readAllLocalPluginConfigs();

  const hostTombs = collectDeletions(
    state.lastSyncedHostIds,
    new Set(localHosts.map((h) => h.id)),
    state.localTombstones.hosts,
    nowMs,
  );
  const wsTombs = collectDeletions(
    state.lastSyncedWorkspaceIds,
    new Set(localWorkspaces.map((w) => w.id)),
    state.localTombstones.workspaces,
    nowMs,
  );
  const snipTombs = collectDeletions(
    state.lastSyncedSnippetIds,
    new Set(localSnippets.map((s) => s.id)),
    state.localTombstones.snippets,
    nowMs,
  );

  let resolvedGistId: string | null = config.gistId.trim() || null;
  let resolvedOwner: string | null = null;
  let remoteUrl: string | null = null;
  let remoteText: string | null = null;

  if (config.mode === 'gist') {
    if (resolvedGistId && !remote.gists[resolvedGistId]) {
      resolvedGistId = null;
      config.gistId = '';
      writeLs(LS_SYNC_CONFIG, config);
    }
    if (!resolvedGistId) {
      const found = discoverMockGists(remote, config.gistFileName);
      if (found.length > 0) {
        resolvedGistId = found[0].id;
        config.gistId = resolvedGistId;
        writeLs(LS_SYNC_CONFIG, config);
      }
    }
    if (resolvedGistId && remote.gists[resolvedGistId]) {
      const g = remote.gists[resolvedGistId];
      remoteUrl = g.htmlUrl;
      remoteText = g.files[config.gistFileName] ?? g.files['lighterm-sync.json'] ?? null;
    }
  } else {
    const owner = config.repoOwner.trim() || creds.accountLogin || 'github-user';
    if (!config.repoOwner.trim()) {
      config.repoOwner = owner;
      writeLs(LS_SYNC_CONFIG, config);
    }
    resolvedOwner = owner;
    const repoKey = `${owner}/${config.repoName}`;
    const repo = remote.repos[repoKey];
    if (!repo) {
      if (action === 'pull' || !config.autoCreateTarget) {
        throw new Error(`GitHub repository ${repoKey} was not found`);
      }
      remote.repos[repoKey] = {
        owner,
        name: config.repoName,
        private: true,
        defaultBranch: config.repoBranch,
        htmlUrl: `https://github.com/${repoKey}`,
        files: {},
      };
      remoteUrl = `https://github.com/${repoKey}`;
    } else {
      remoteUrl = repo.htmlUrl;
      remoteText = repo.files[config.repoFilePath] ?? null;
    }
  }

  let remoteEnvelope: MockSyncEnvelope | null = null;
  let remotePayload: MockSyncPayload | null = null;
  if (remoteText) {
    remoteEnvelope = JSON.parse(remoteText) as MockSyncEnvelope;
    if (remoteEnvelope.encrypted && remoteEnvelope.encryption) {
      remotePayload = mockDecryptPayload(remoteEnvelope.encryption, creds.encryptionPassphrase);
    } else if (remoteEnvelope.payload) {
      remotePayload = remoteEnvelope.payload;
    }
  }

  const isFirstSync = !state.status.lastSyncAt;
  let finalHosts = localHosts;
  let finalSettings = localSettings;
  let finalWorkspaces = localWorkspaces;
  let finalSnippets = localSnippets;
  let finalPluginStates = localPluginStates;
  let finalPluginConfigs = localPluginConfigs;
  let finalTombstones: MockTombstones = {
    hosts: hostTombs,
    workspaces: wsTombs,
    snippets: snipTombs,
  };
  let applyLocal = false;
  let pushRemote = false;

  if (action === 'pull') {
    if (!remoteEnvelope || !remotePayload) {
      throw new Error('No remote configuration data found on GitHub to pull.');
    }
    if (config.scopes.hosts && remotePayload.hosts) {
      const localMap = new Map(localHosts.map((h) => [h.id, h]));
      finalHosts = remotePayload.hostsIncludeSecrets
        ? remotePayload.hosts
        : remotePayload.hosts.map((h) => preserveLocalSecrets(h, localMap.get(h.id)));
    }
    if (config.scopes.settings && remotePayload.settings) {
      finalSettings = remotePayload.settings;
    }
    if (config.scopes.workspaces && remotePayload.workspaces) {
      finalWorkspaces = remotePayload.workspaces;
    }
    if (config.scopes.snippets && remotePayload.snippets) {
      finalSnippets = remotePayload.snippets;
    }
    if (config.scopes.plugins) {
      if (remotePayload.pluginStates) {
        finalPluginStates = { ...localPluginStates };
        for (const [k, v] of Object.entries(remotePayload.pluginStates)) {
          if (k !== SYNC_PLUGIN_ID) finalPluginStates[k] = v;
        }
      }
      if (remotePayload.pluginConfigs) {
        finalPluginConfigs = { ...remotePayload.pluginConfigs };
        delete finalPluginConfigs[SYNC_PLUGIN_ID];
      }
    }
    finalTombstones = {
      hosts: mergeTombstones(hostTombs, remotePayload.tombstones.hosts, nowMs),
      workspaces: mergeTombstones(wsTombs, remotePayload.tombstones.workspaces, nowMs),
      snippets: mergeTombstones(snipTombs, remotePayload.tombstones.snippets, nowMs),
    };
    applyLocal = true;
  } else if (action === 'push') {
    if (remotePayload) {
      finalTombstones = {
        hosts: mergeTombstones(hostTombs, remotePayload.tombstones.hosts, nowMs),
        workspaces: mergeTombstones(wsTombs, remotePayload.tombstones.workspaces, nowMs),
        snippets: mergeTombstones(snipTombs, remotePayload.tombstones.snippets, nowMs),
      };
    }
    pushRemote = true;
  } else if (remoteEnvelope && remotePayload) {
    finalTombstones = {
      hosts: mergeTombstones(hostTombs, remotePayload.tombstones.hosts, nowMs),
      workspaces: mergeTombstones(wsTombs, remotePayload.tombstones.workspaces, nowMs),
      snippets: mergeTombstones(snipTombs, remotePayload.tombstones.snippets, nowMs),
    };
    if (config.scopes.hosts && remotePayload.hosts) {
      const localMap = new Map(localHosts.map((h) => [h.id, h]));
      const merged = mergeEntities(
        localHosts,
        remotePayload.hosts,
        finalTombstones.hosts,
        config.conflictResolution,
      );
      finalHosts = remotePayload.hostsIncludeSecrets
        ? merged
        : merged.map((h) => preserveLocalSecrets(h, localMap.get(h.id)));
    }
    if (config.scopes.settings && remotePayload.settings) {
      const lHash = canonicalHash(localSettings);
      const rHash = canonicalHash(remotePayload.settings);
      if (lHash !== rHash) {
        if (isFirstSync && lHash === canonicalHash(createDefaultSettings())) {
          finalSettings = remotePayload.settings;
        } else if (state.lastSettingsHash && lHash === state.lastSettingsHash) {
          finalSettings = remotePayload.settings;
        } else if (state.lastSettingsHash && rHash === state.lastSettingsHash) {
          finalSettings = localSettings;
        } else {
          finalSettings =
            config.conflictResolution === 'local' ? localSettings : remotePayload.settings;
        }
      }
    }
    if (config.scopes.workspaces && remotePayload.workspaces) {
      finalWorkspaces = mergeEntities(
        localWorkspaces,
        remotePayload.workspaces,
        finalTombstones.workspaces,
        config.conflictResolution,
      );
    }
    if (config.scopes.snippets && remotePayload.snippets) {
      const rKeys = new Set(
        remotePayload.snippets.map((s) => `${s.title.trim()}::${s.command.trim()}`),
      );
      const rIds = new Set(remotePayload.snippets.map((s) => s.id));
      const filteredLocal = isFirstSync
        ? localSnippets.filter(
            (s) => rIds.has(s.id) || !rKeys.has(`${s.title.trim()}::${s.command.trim()}`),
          )
        : localSnippets;
      finalSnippets = mergeEntities(
        filteredLocal,
        remotePayload.snippets,
        finalTombstones.snippets,
        config.conflictResolution,
      );
    }
    if (config.scopes.plugins && (remotePayload.pluginStates || remotePayload.pluginConfigs)) {
      const localBundle = {
        pluginStates: Object.fromEntries(
          Object.entries(localPluginStates).filter(([k]) => k !== SYNC_PLUGIN_ID),
        ),
        pluginConfigs: localPluginConfigs,
      };
      const remoteBundle = {
        pluginStates: remotePayload.pluginStates ?? localBundle.pluginStates,
        pluginConfigs: remotePayload.pluginConfigs ?? localBundle.pluginConfigs,
      };
      const lHash = canonicalHash(localBundle);
      const rHash = canonicalHash(remoteBundle);
      if (lHash !== rHash) {
        const useRemote =
          (state.lastPluginsHash && lHash === state.lastPluginsHash) ||
          (!(state.lastPluginsHash && rHash === state.lastPluginsHash) &&
            config.conflictResolution !== 'local');
        if (useRemote) {
          finalPluginStates = {
            ...remoteBundle.pluginStates,
            ...(SYNC_PLUGIN_ID in localPluginStates
              ? { [SYNC_PLUGIN_ID]: localPluginStates[SYNC_PLUGIN_ID] }
              : {}),
          };
          finalPluginConfigs = remoteBundle.pluginConfigs;
        }
      }
    }
    applyLocal = true;
    pushRemote = true;
  } else {
    pushRemote = true;
  }

  const hostsChanged = canonicalHash(localHosts) !== canonicalHash(finalHosts);
  const settingsChanged = canonicalHash(localSettings) !== canonicalHash(finalSettings);
  const workspacesChanged = canonicalHash(localWorkspaces) !== canonicalHash(finalWorkspaces);
  const snippetsChanged = canonicalHash(localSnippets) !== canonicalHash(finalSnippets);
  const pluginStatesChanged =
    canonicalHash(localPluginStates) !== canonicalHash(finalPluginStates);
  const pluginConfigsChanged =
    canonicalHash(localPluginConfigs) !== canonicalHash(finalPluginConfigs);

  let appliedLocal = false;
  const updatedPluginStates: Record<string, boolean> = {};
  if (applyLocal) {
    if (config.scopes.hosts && hostsChanged) {
      writeLs(LS_HOSTS, finalHosts);
      appliedLocal = true;
    }
    if (config.scopes.settings && settingsChanged) {
      writeLs(LS_SETTINGS, finalSettings);
      appliedLocal = true;
    }
    if (config.scopes.workspaces && workspacesChanged) {
      writeLs(LS_WORKSPACES, finalWorkspaces);
      appliedLocal = true;
    }
    if (config.scopes.snippets && snippetsChanged) {
      writeLs(LS_SNIPPETS, finalSnippets);
      appliedLocal = true;
    }
    if (config.scopes.plugins) {
      if (pluginStatesChanged) {
        writeLs(LS_ENABLED_PLUGINS, finalPluginStates);
        for (const [k, v] of Object.entries(finalPluginStates)) {
          if (k !== SYNC_PLUGIN_ID) updatedPluginStates[k] = v;
        }
        appliedLocal = true;
      }
      if (pluginConfigsChanged) {
        writeAllLocalPluginConfigs(finalPluginConfigs);
        appliedLocal = true;
      }
    }
  }

  const outgoingPayload: MockSyncPayload = {
    hosts: config.scopes.hosts
      ? config.scopes.includeHostSecrets
        ? finalHosts
        : finalHosts.map(stripHostSecrets)
      : remotePayload?.hosts,
    hostsIncludeSecrets: config.scopes.hosts
      ? config.scopes.includeHostSecrets
      : Boolean(remotePayload?.hostsIncludeSecrets),
    settings: config.scopes.settings ? finalSettings : remotePayload?.settings,
    workspaces: config.scopes.workspaces ? finalWorkspaces : remotePayload?.workspaces,
    snippets: config.scopes.snippets ? finalSnippets : remotePayload?.snippets,
    pluginStates: config.scopes.plugins
      ? Object.fromEntries(
          Object.entries(finalPluginStates).filter(([k]) => k !== SYNC_PLUGIN_ID),
        )
      : remotePayload?.pluginStates,
    pluginConfigs: config.scopes.plugins ? finalPluginConfigs : remotePayload?.pluginConfigs,
    tombstones: finalTombstones,
  };

  const willEncrypt = Boolean(creds.encryptionPassphrase.trim());
  const skipUpload =
    action === 'sync' &&
    remoteEnvelope !== null &&
    remotePayload !== null &&
    remoteEnvelope.encrypted === willEncrypt &&
    canonicalHash(remotePayload) === canonicalHash(outgoingPayload);

  let pushedRemote = false;
  if (pushRemote && !skipUpload) {
    const envelope: MockSyncEnvelope = willEncrypt
      ? {
          format: 'lighterm-sync',
          version: 1,
          encrypted: true,
          updatedAt: nowMs,
          deviceName: config.deviceName,
          encryption: mockEncryptPayload(outgoingPayload, creds.encryptionPassphrase),
        }
      : {
          format: 'lighterm-sync',
          version: 1,
          encrypted: false,
          updatedAt: nowMs,
          deviceName: config.deviceName,
          payload: outgoingPayload,
        };
    const serialized = JSON.stringify(envelope, null, 2);

    if (config.mode === 'gist') {
      if (!resolvedGistId) {
        if (!config.autoCreateTarget) {
          throw new Error('Gist ID is empty and auto-creation is disabled');
        }
        resolvedGistId = makeUuid('gist');
        config.gistId = resolvedGistId;
        writeLs(LS_SYNC_CONFIG, config);
      }
      remoteUrl = `https://gist.github.com/${resolvedGistId}`;
      remote.gists[resolvedGistId] = {
        id: resolvedGistId,
        description: MANAGED_GIST_DESCRIPTION,
        public: false,
        updatedAt: new Date(nowMs).toISOString(),
        htmlUrl: remoteUrl,
        files: {
          ...(remote.gists[resolvedGistId]?.files ?? {}),
          [config.gistFileName]: serialized,
        },
      };
    } else {
      const owner = resolvedOwner ?? creds.accountLogin ?? 'github-user';
      const repoKey = `${owner}/${config.repoName}`;
      remote.repos[repoKey].files[config.repoFilePath] = serialized;
      remoteUrl = remote.repos[repoKey].htmlUrl;
    }

    writeLs(LS_SYNC_MOCK_REMOTE, remote);
    pushedRemote = true;
  }

  const summary =
    action === 'push'
      ? `Pushed ${finalHosts.length} hosts, ${finalWorkspaces.length} workspaces, ${finalSnippets.length} snippets to GitHub`
      : action === 'pull' && appliedLocal
        ? `Pulled ${finalHosts.length} hosts, ${finalWorkspaces.length} workspaces, ${finalSnippets.length} snippets from GitHub`
        : action === 'pull'
          ? 'Local configuration is already up to date with GitHub'
          : appliedLocal && pushedRemote
            ? `Synced (updated local & GitHub): ${finalHosts.length} hosts, ${finalWorkspaces.length} workspaces, ${finalSnippets.length} snippets`
            : appliedLocal
              ? `Synced from GitHub: ${finalHosts.length} hosts, ${finalWorkspaces.length} workspaces, ${finalSnippets.length} snippets`
              : pushedRemote
                ? `Synced to GitHub: ${finalHosts.length} hosts, ${finalWorkspaces.length} workspaces, ${finalSnippets.length} snippets`
                : 'Everything is already in sync';

  const status: SyncStatusState = {
    lastSyncAt: nowMs,
    lastAction: action,
    lastStatus: 'ok',
    lastMessage: summary,
    lastError: null,
    lastRemoteUpdatedAt: pushedRemote ? nowMs : (remoteEnvelope?.updatedAt ?? nowMs),
    lastRemoteDevice: pushedRemote
      ? config.deviceName
      : (remoteEnvelope?.deviceName ?? config.deviceName),
    remoteAccount: creds.accountLogin ?? 'github-user',
    remoteUrl,
    remoteEncrypted: pushedRemote ? willEncrypt : Boolean(remoteEnvelope?.encrypted),
  };

  const nextState: MockSyncLocalState = {
    status,
    lastSyncedHostIds: finalHosts.map((h) => h.id),
    lastSyncedWorkspaceIds: finalWorkspaces.map((w) => w.id),
    lastSyncedSnippetIds: finalSnippets.map((s) => s.id),
    lastSettingsHash: canonicalHash(finalSettings),
    lastPluginsHash: canonicalHash({
      pluginStates: Object.fromEntries(
        Object.entries(finalPluginStates).filter(([k]) => k !== SYNC_PLUGIN_ID),
      ),
      pluginConfigs: finalPluginConfigs,
    }),
    localTombstones: finalTombstones,
  };
  writeLs(LS_SYNC_STATE, nextState);

  return {
    action,
    appliedLocal,
    pushedRemote,
    encrypted: Boolean(status.remoteEncrypted),
    remoteUrl,
    gistId: resolvedGistId,
    repoOwner: resolvedOwner,
    remoteUpdatedAt: status.lastRemoteUpdatedAt ?? null,
    summary,
    counts: {
      hosts: finalHosts.length,
      workspaces: finalWorkspaces.length,
      snippets: finalSnippets.length,
      settingsUpdated: appliedLocal && settingsChanged,
      pluginsUpdated: appliedLocal && (pluginStatesChanged || pluginConfigsChanged),
    },
    status,
    invalidatedHostIds: [],
    updatedPluginStates,
  };
}

async function applyLiveReloadIfNeeded(result: SyncOperationResult): Promise<void> {
  if (!result.appliedLocal) return;
  await shellService.reloadAll();
  await pluginKernel.reloadPluginConfigsFromBackend();
  if (Object.keys(result.updatedPluginStates).length > 0) {
    await pluginKernel.applyPluginEnabledStates(result.updatedPluginStates, SYNC_PLUGIN_ID);
  }
}

export const syncClient = {
  async loadConfig(): Promise<SyncConfigView> {
    try {
      const view = isTauriRuntime()
        ? await invokeTauri<SyncConfigView>('sync_get_config')
        : getMockView();
      useSyncPluginStore.setState({ view, loaded: true, error: null });
      return view;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({ error: msg, loaded: true });
      throw err;
    }
  },

  async saveConfig(input: SyncConfigUpdateInput): Promise<SyncConfigView> {
    try {
      let view: SyncConfigView;
      if (isTauriRuntime()) {
        view = await invokeTauri<SyncConfigView>('sync_save_config', { input });
      } else {
        const creds = readMockCreds();
        if (input.encryptionPassphrase !== undefined && input.encryptionPassphrase !== null) {
          creds.encryptionPassphrase = input.encryptionPassphrase;
        }
        if (input.config.scopes.includeHostSecrets && !creds.encryptionPassphrase.trim()) {
          throw new Error(
            'An Encryption Passphrase is required when syncing SSH passwords, private keys, or passphrases.',
          );
        }
        writeLs(LS_SYNC_CONFIG, input.config);
        writeLs(LS_SYNC_CREDS, creds);
        view = getMockView();
      }
      useSyncPluginStore.setState({ view, loaded: true, error: null });
      return view;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({ error: msg });
      throw err;
    }
  },

  async startOAuth(
    configOverride?: GitHubSyncConfig | null,
    openBrowser = true,
  ): Promise<OAuthDeviceFlowStart> {
    useSyncPluginStore.setState({
      oauthStarting: true,
      oauthPolling: false,
      oauthStatusMessage: null,
      error: null,
    });
    try {
      let flow: OAuthDeviceFlowStart;
      if (isTauriRuntime()) {
        flow = await invokeTauri<OAuthDeviceFlowStart>('sync_oauth_start', {
          configOverride: configOverride ?? null,
          openBrowser,
        });
      } else {
        const cfg = configOverride ?? readMockConfig();
        const flowId = makeUuid('oauth');
        const scopes = cfg.mode === 'repo' ? ['gist', 'repo'] : ['gist'];
        mockPendingFlows.set(flowId, {
          flowId,
          scopes,
          mode: cfg.mode,
          gistFileName: cfg.gistFileName,
          status: 'pending',
        });
        flow = {
          flowId,
          userCode: 'LGTM-2026',
          verificationUri: 'https://github.com/login/device',
          expiresIn: 900,
          interval: 1,
          scopes,
          browserOpened: false,
        };
      }
      useSyncPluginStore.setState({
        oauthStarting: false,
        oauthPolling: true,
        oauthFlow: flow,
        oauthStatusMessage: 'Waiting for GitHub authorization...',
      });
      return flow;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({
        oauthStarting: false,
        oauthPolling: false,
        oauthFlow: null,
        error: msg,
      });
      throw err;
    }
  },

  async pollOAuth(flowId: string): Promise<OAuthPollResult> {
    try {
      let result: OAuthPollResult;
      if (isTauriRuntime()) {
        result = await invokeTauri<OAuthPollResult>('sync_oauth_poll', { flowId });
      } else {
        const entry = mockPendingFlows.get(flowId);
        if (!entry) {
          result = {
            status: 'expired',
            message: 'No active GitHub OAuth authorization session.',
            discoveredGists: [],
          };
        } else if (entry.status === 'pending') {
          result = {
            status: 'pending',
            interval: 1,
            discoveredGists: [],
          };
        } else if (entry.status === 'denied') {
          mockPendingFlows.delete(flowId);
          result = {
            status: 'denied',
            message: 'GitHub authorization was cancelled by the user.',
            discoveredGists: [],
          };
        } else if (entry.status === 'expired') {
          mockPendingFlows.delete(flowId);
          result = {
            status: 'expired',
            message: 'GitHub OAuth device code expired. Please try again.',
            discoveredGists: [],
          };
        } else {
          mockPendingFlows.delete(flowId);
          const creds = readMockCreds();
          creds.accessToken = makeUuid('gho_oauth');
          creds.scopes = entry.scopes;
          creds.accountLogin = 'github-user';
          creds.accountName = 'GitHub User';
          writeLs(LS_SYNC_CREDS, creds);

          const state = readMockState();
          state.status.remoteAccount = 'github-user';
          state.status.lastError = null;
          writeLs(LS_SYNC_STATE, state);

          let discoveredGists: DiscoveredGist[] = [];
          if (entry.mode === 'gist') {
            discoveredGists = discoverMockGists(readMockRemote(), entry.gistFileName);
            const cfg = readMockConfig();
            if (!cfg.gistId.trim() && discoveredGists.length > 0) {
              cfg.gistId = discoveredGists[0].id;
              writeLs(LS_SYNC_CONFIG, cfg);
            }
          }

          result = {
            status: 'authorized',
            message: 'Signed in as @github-user.',
            view: getMockView(),
            discoveredGists,
          };
        }
      }

      if (result.status === 'authorized' && result.view) {
        useSyncPluginStore.setState({
          view: result.view,
          oauthFlow: null,
          oauthPolling: false,
          oauthStatusMessage: result.message ?? 'Signed in to GitHub.',
          discoveredGists:
            result.discoveredGists.length > 0
              ? result.discoveredGists
              : useSyncPluginStore.getState().discoveredGists,
          error: null,
        });
      } else if (result.status === 'expired' || result.status === 'denied') {
        useSyncPluginStore.setState({
          oauthFlow: null,
          oauthPolling: false,
          oauthStatusMessage: null,
          error: result.message ?? 'GitHub OAuth authorization did not complete.',
        });
      }
      return result;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({
        oauthFlow: null,
        oauthPolling: false,
        error: msg,
      });
      throw err;
    }
  },

  approveMockOAuth(flowId: string): void {
    const entry = mockPendingFlows.get(flowId);
    if (entry) {
      entry.status = 'authorized';
    }
  },

  denyMockOAuth(flowId: string): void {
    const entry = mockPendingFlows.get(flowId);
    if (entry) {
      entry.status = 'denied';
    }
  },

  async cancelOAuth(flowId?: string): Promise<void> {
    const targetId = flowId ?? useSyncPluginStore.getState().oauthFlow?.flowId;
    if (targetId) {
      if (isTauriRuntime()) {
        await invokeTauri<void>('sync_oauth_cancel', { flowId: targetId }).catch(() => {});
      } else {
        mockPendingFlows.delete(targetId);
      }
    }
    useSyncPluginStore.setState({
      oauthFlow: null,
      oauthStarting: false,
      oauthPolling: false,
      oauthStatusMessage: null,
    });
  },

  async logout(): Promise<SyncConfigView> {
    let view: SyncConfigView;
    if (isTauriRuntime()) {
      view = await invokeTauri<SyncConfigView>('sync_oauth_logout');
    } else {
      mockPendingFlows.clear();
      const creds = readMockCreds();
      creds.accessToken = '';
      creds.scopes = [];
      creds.accountLogin = null;
      creds.accountName = null;
      creds.accountAvatarUrl = null;
      writeLs(LS_SYNC_CREDS, creds);

      const state = readMockState();
      state.status.remoteAccount = null;
      state.status.lastError = null;
      writeLs(LS_SYNC_STATE, state);
      view = getMockView();
    }
    useSyncPluginStore.setState({
      view,
      oauthFlow: null,
      oauthPolling: false,
      oauthStatusMessage: null,
      lastTestResult: null,
      discoveredGists: [],
      error: null,
    });
    return view;
  },

  async openVerificationUrl(url: string): Promise<void> {
    if (isTauriRuntime()) {
      await invokeTauri<void>('sync_open_verification_url', { url });
    } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  async resetLocalState(): Promise<SyncConfigView> {
    const view = isTauriRuntime()
      ? await invokeTauri<SyncConfigView>('sync_reset_state')
      : (() => {
          const creds = readMockCreds();
          writeLs(LS_SYNC_STATE, {
            status: creds.accessToken.trim() ? { remoteAccount: creds.accountLogin } : {},
            lastSyncedHostIds: [],
            lastSyncedWorkspaceIds: [],
            lastSyncedSnippetIds: [],
            lastSettingsHash: null,
            lastPluginsHash: null,
            localTombstones: { hosts: {}, workspaces: {}, snippets: {} },
          });
          return getMockView();
        })();
    useSyncPluginStore.setState({ view, error: null });
    return view;
  },

  async testConnection(configOverride?: GitHubSyncConfig | null): Promise<SyncTestResult> {
    useSyncPluginStore.setState({ testing: true, error: null });
    try {
      let result: SyncTestResult;
      if (isTauriRuntime()) {
        result = await invokeTauri<SyncTestResult>('sync_test_connection', {
          configOverride: configOverride ?? null,
        });
      } else {
        const cfg = configOverride ?? readMockConfig();
        const creds = readMockCreds();
        if (!creds.accessToken.trim()) {
          throw new Error('Not signed in to GitHub. Please sign in with GitHub OAuth first.');
        }
        const login = creds.accountLogin || 'github-user';
        const remote = readMockRemote();
        if (cfg.mode === 'gist') {
          const discovered = discoverMockGists(remote, cfg.gistFileName);
          const target = cfg.gistId.trim() ? remote.gists[cfg.gistId.trim()] : undefined;
          result = {
            success: true,
            username: login,
            targetExists: Boolean(target) || discovered.length > 0,
            targetUrl: target?.htmlUrl ?? discovered[0]?.htmlUrl ?? null,
            isPublicTarget: Boolean(target?.public),
            discoveredGists: discovered,
            message: target
              ? `Authenticated as @${login}. Connected to Secret Gist ${target.id}.`
              : discovered.length > 0
                ? `Authenticated as @${login}. Found ${discovered.length} existing Lighterm Gist(s).`
                : `Authenticated as @${login}. A Secret Gist will be created on first Sync/Push.`,
          };
        } else {
          const owner = cfg.repoOwner.trim() || login;
          const repoKey = `${owner}/${cfg.repoName}`;
          const repo = remote.repos[repoKey];
          result = {
            success: true,
            username: login,
            targetExists: Boolean(repo),
            targetUrl: repo?.htmlUrl ?? null,
            isPublicTarget: repo ? !repo.private : false,
            discoveredGists: [],
            message: repo
              ? `Authenticated as @${login}. Private repository ${repoKey} is ready.`
              : `Authenticated as @${login}. Repository ${repoKey} will be created on first Push/Sync.`,
          };
        }
      }
      useSyncPluginStore.setState({
        testing: false,
        lastTestResult: result,
        discoveredGists: result.discoveredGists,
      });
      return result;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({ testing: false, error: msg, lastTestResult: null });
      throw err;
    }
  },

  async discoverGists(
    apiBaseUrl?: string | null,
    fileName?: string | null,
  ): Promise<DiscoveredGist[]> {
    useSyncPluginStore.setState({ discovering: true, error: null });
    try {
      let gists: DiscoveredGist[];
      if (isTauriRuntime()) {
        gists = await invokeTauri<DiscoveredGist[]>('sync_discover_gists', {
          apiBaseUrl: apiBaseUrl ?? null,
          fileName: fileName ?? null,
        });
      } else {
        const creds = readMockCreds();
        if (!creds.accessToken.trim()) {
          throw new Error('Not signed in to GitHub. Please sign in with GitHub OAuth first.');
        }
        const cfg = readMockConfig();
        gists = discoverMockGists(readMockRemote(), fileName ?? cfg.gistFileName);
      }
      useSyncPluginStore.setState({ discovering: false, discoveredGists: gists });
      return gists;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState({ discovering: false, error: msg });
      throw err;
    }
  },

  async runOperation(
    action: 'sync' | 'push' | 'pull',
    opts?: { silent?: boolean },
  ): Promise<SyncOperationResult | null> {
    if (useSyncPluginStore.getState().syncing) return null;
    useSyncPluginStore.setState({ syncing: true, error: null });
    try {
      const cmd = action === 'sync' ? 'sync_now' : action === 'push' ? 'sync_push' : 'sync_pull';
      const result = isTauriRuntime()
        ? await invokeTauri<SyncOperationResult>(cmd)
        : runMockSyncOperation(action);

      await applyLiveReloadIfNeeded(result);
      const view = isTauriRuntime()
        ? await invokeTauri<SyncConfigView>('sync_get_config').catch(() => ({
            ...useSyncPluginStore.getState().view,
            status: result.status,
          }))
        : getMockView();

      useSyncPluginStore.setState({
        syncing: false,
        view,
        lastResult: result,
        error: null,
      });
      return result;
    } catch (err) {
      const msg = formatError(err);
      useSyncPluginStore.setState((s) => ({
        syncing: false,
        error: msg,
        view: {
          ...s.view,
          status: {
            ...s.view.status,
            lastStatus: 'error',
            lastError: msg,
          },
        },
      }));
      if (!opts?.silent) {
        throw err;
      }
      return null;
    }
  },

  syncNow(opts?: { silent?: boolean }): Promise<SyncOperationResult | null> {
    return this.runOperation('sync', opts);
  },

  push(opts?: { silent?: boolean }): Promise<SyncOperationResult | null> {
    return this.runOperation('push', opts);
  },

  pull(opts?: { silent?: boolean }): Promise<SyncOperationResult | null> {
    return this.runOperation('pull', opts);
  },

  resetForTesting(): void {
    mockPendingFlows.clear();
    useSyncPluginStore.setState({
      view: createInitialView(),
      loaded: false,
      syncing: false,
      testing: false,
      discovering: false,
      oauthStarting: false,
      oauthPolling: false,
      oauthFlow: null,
      oauthStatusMessage: null,
      discoveredGists: [],
      lastTestResult: null,
      lastResult: null,
      error: null,
    });
  },
};
