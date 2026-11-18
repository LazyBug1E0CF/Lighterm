import React, { useEffect, useState } from 'react';
import { CheckCircle2, Eye, EyeOff, FolderSearch, Loader2, X, XCircle } from 'lucide-react';
import { pickOpenFile } from '../../services/backend';
import { useAppStore } from '../../store/useAppStore';
import type { ConnectionTestResult, HostConfig } from '../../types';

const COLOR_SWATCHES = ['#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff', '#e0af68', '#f7768e'];

export const HostFormModal: React.FC = () => {
  const hostModalOpen = useAppStore((s) => s.hostModalOpen);
  const editingHost = useAppStore((s) => s.editingHost);
  const closeHostModal = useAppStore((s) => s.closeHostModal);
  const saveHost = useAppStore((s) => s.saveHost);
  const openSshTab = useAppStore((s) => s.openSshTab);
  const testHostConnection = useAppStore((s) => s.testHostConnection);

  const [name, setName] = useState('');
  const [group, setGroup] = useState('Production');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<'password' | 'privateKey'>('password');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [keyPath, setKeyPath] = useState('~/.ssh/id_ed25519');
  const [privateKeyPem, setPrivateKeyPem] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [defaultPath, setDefaultPath] = useState('');
  const [startupCommand, setStartupCommand] = useState('');
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!hostModalOpen) return;
    setTestResult(null);
    if (editingHost) {
      setName(editingHost.name);
      setGroup(editingHost.group || 'Default');
      setHost(editingHost.host);
      setPort(String(editingHost.port || 22));
      setUsername(editingHost.username);
      setAuthType(editingHost.auth.type);
      if (editingHost.auth.type === 'password') {
        setPassword(editingHost.auth.password ?? '');
        setKeyPath('~/.ssh/id_ed25519');
        setPrivateKeyPem('');
        setPassphrase('');
      } else {
        setPassword('');
        setKeyPath(editingHost.auth.keyPath ?? '');
        setPrivateKeyPem(editingHost.auth.privateKeyPem ?? '');
        setPassphrase(editingHost.auth.passphrase ?? '');
      }
      setDefaultPath(editingHost.defaultPath ?? '');
      setStartupCommand(editingHost.startupCommand ?? '');
      setColor(editingHost.color ?? COLOR_SWATCHES[0]);
    } else {
      setName('');
      setGroup('Default');
      setHost('');
      setPort('22');
      setUsername('root');
      setAuthType('password');
      setPassword('');
      setKeyPath('~/.ssh/id_ed25519');
      setPrivateKeyPem('');
      setPassphrase('');
      setDefaultPath('');
      setStartupCommand('');
      setColor(COLOR_SWATCHES[0]);
    }
  }, [hostModalOpen, editingHost]);

  if (!hostModalOpen) return null;

  const buildConfig = (): HostConfig => ({
    id: editingHost?.id ?? '',
    name: name.trim() || `${username.trim() || 'user'}@${host.trim()}`,
    group: group.trim() || 'Default',
    host: host.trim(),
    port: Math.max(1, Math.min(65535, Number(port) || 22)),
    username: username.trim(),
    auth:
      authType === 'password'
        ? { type: 'password', password }
        : {
            type: 'privateKey',
            keyPath: keyPath.trim() || null,
            privateKeyPem: privateKeyPem.trim() || null,
            passphrase: passphrase || null,
          },
    defaultPath: defaultPath.trim() || null,
    startupCommand: startupCommand.trim() || null,
    color,
    updatedAt: Date.now(),
  });

  const handleBrowseKey = async () => {
    const selected = await pickOpenFile('Select SSH Private Key');
    if (selected) setKeyPath(selected);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testHostConnection(buildConfig());
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (connectAfter: boolean) => {
    if (!host.trim() || !username.trim()) return;
    setSaving(true);
    try {
      const saved = await saveHost(buildConfig());
      if (connectAfter) {
        await openSshTab(saved);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={closeHostModal}
    >
      <div
        role="dialog"
        aria-label={editingHost ? 'Edit SSH Host' : 'New SSH Host'}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-4 py-3 flex items-center justify-between border-b border-[var(--border-subtle)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {editingHost ? 'Edit SSH Host' : 'New SSH Host'}
          </h2>
          <button
            type="button"
            onClick={closeHostModal}
            aria-label="Close Host Modal"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto lighterm-scroll text-xs">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Display Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Prod Web 01"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Group</span>
              <input
                type="text"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="Production"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
          </div>

          <div className="grid grid-cols-12 gap-3">
            <label className="col-span-6 block">
              <span className="text-[var(--text-muted)] block mb-1">Host / IP *</span>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.50"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
            <label className="col-span-2 block">
              <span className="text-[var(--text-muted)] block mb-1">Port</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                className="w-full h-8 px-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
            <label className="col-span-4 block">
              <span className="text-[var(--text-muted)] block mb-1">Username *</span>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ubuntu"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
          </div>

          {/* Auth Method Toggle */}
          <div>
            <span className="text-[var(--text-muted)] block mb-1">Authentication</span>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[var(--bg-app)] border border-[var(--border-subtle)]">
              <button
                type="button"
                onClick={() => setAuthType('password')}
                className={`h-7 rounded-md font-medium transition-colors ${
                  authType === 'password'
                    ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Password
              </button>
              <button
                type="button"
                onClick={() => setAuthType('privateKey')}
                className={`h-7 rounded-md font-medium transition-colors ${
                  authType === 'privateKey'
                    ? 'bg-[var(--bg-elevated)] text-[var(--accent)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                Private Key
              </button>
            </div>
          </div>

          {authType === 'password' ? (
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Password</span>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter SSH password"
                  className="w-full h-8 pl-2.5 pr-8 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </label>
          ) : (
            <div className="space-y-2.5">
              <label className="block">
                <span className="text-[var(--text-muted)] block mb-1">Private Key Path</span>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                    className="flex-1 h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono focus:border-[var(--accent)] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => void handleBrowseKey()}
                    className="h-8 px-2.5 rounded-md bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent)] flex items-center gap-1"
                  >
                    <FolderSearch className="w-3.5 h-3.5" />
                    Browse
                  </button>
                </div>
              </label>

              <label className="block">
                <span className="text-[var(--text-muted)] block mb-1">
                  Or Paste Private Key (OpenSSH / PEM)
                </span>
                <textarea
                  rows={3}
                  value={privateKeyPem}
                  onChange={(e) => setPrivateKeyPem(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  className="w-full p-2 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono text-[11px] focus:border-[var(--accent)] outline-none"
                />
              </label>

              <label className="block">
                <span className="text-[var(--text-muted)] block mb-1">Key Passphrase (optional)</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Optional key passphrase"
                  className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
                />
              </label>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Default SFTP Path</span>
              <input
                type="text"
                value={defaultPath}
                onChange={(e) => setDefaultPath(e.target.value)}
                placeholder="/var/www"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono focus:border-[var(--accent)] outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Startup Command</span>
              <input
                type="text"
                value={startupCommand}
                onChange={(e) => setStartupCommand(e.target.value)}
                placeholder="cd /var/www && ls"
                className="w-full h-8 px-2.5 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono focus:border-[var(--accent)] outline-none"
              />
            </label>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-[var(--text-muted)]">Tag Color</span>
            <div className="flex items-center gap-2">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setColor(swatch)}
                  className={`w-5 h-5 rounded-full border-2 transition-transform ${
                    color === swatch ? 'scale-110 border-white' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>

          {testResult && (
            <div
              className={`p-2.5 rounded-md border flex items-center gap-2 ${
                testResult.success
                  ? 'border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]'
                  : 'border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)]'
              }`}
            >
              {testResult.success ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0" />
              )}
              <span className="flex-1 truncate">
                {testResult.message} ({testResult.latencyMs} ms)
              </span>
            </div>
          )}
        </div>

        <div className="px-4 py-3 flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--bg-app)]/50 text-xs">
          <button
            type="button"
            disabled={testing || !host.trim() || !username.trim()}
            onClick={() => void handleTest()}
            className="h-8 px-3 rounded-md border border-[var(--border-subtle)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 flex items-center gap-1.5"
          >
            {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Test Connection
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving || !host.trim() || !username.trim()}
              onClick={() => void handleSubmit(false)}
              className="h-8 px-3 rounded-md bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/80 disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              disabled={saving || !host.trim() || !username.trim()}
              onClick={() => void handleSubmit(true)}
              className="h-8 px-3.5 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 disabled:opacity-40"
            >
              Save &amp; Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
