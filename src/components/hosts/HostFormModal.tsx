import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  FolderSearch,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';
import { pickOpenFile } from '../../core/ipc';
import { shellService, useShellStore } from '../../core/shellService';
import type { ConnectionTestResult, HostConfig } from '../../types';

const COLOR_SWATCHES = ['#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff', '#e0af68', '#f7768e'];

export const HostFormModal: React.FC = () => {
  const hostModalOpen = useShellStore((s) => s.hostModalOpen);
  const editingHost = useShellStore((s) => s.editingHost);
  const hosts = useShellStore((s) => s.hosts);

  const [name, setName] = useState('');
  const [group, setGroup] = useState('Production');
  const [groupDropdownOpen, setGroupDropdownOpen] = useState(false);
  const [groupFilterActive, setGroupFilterActive] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const groupComboboxRef = useRef<HTMLDivElement | null>(null);
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
    setGroupDropdownOpen(false);
    setGroupFilterActive(false);
    setHighlightedIdx(-1);
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

  useEffect(() => {
    if (!groupDropdownOpen) return;
    const handleOutsideMouseDown = (e: MouseEvent) => {
      if (groupComboboxRef.current?.contains(e.target as Node)) return;
      setGroupDropdownOpen(false);
      setHighlightedIdx(-1);
    };
    window.addEventListener('mousedown', handleOutsideMouseDown);
    return () => window.removeEventListener('mousedown', handleOutsideMouseDown);
  }, [groupDropdownOpen]);

  const existingGroups = useMemo(() => {
    const unique = new Set<string>();
    for (const h of hosts) {
      unique.add(h.group.trim() || 'Default');
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [hosts]);

  const filteredGroups = useMemo(() => {
    if (!groupFilterActive || !group.trim()) {
      return existingGroups;
    }
    const q = group.trim().toLowerCase();
    return existingGroups.filter((g) => g.toLowerCase().includes(q));
  }, [existingGroups, group, groupFilterActive]);

  const showGroupDropdown = groupDropdownOpen && filteredGroups.length > 0;

  if (!hostModalOpen) return null;

  const selectGroup = (value: string) => {
    setGroup(value);
    setGroupFilterActive(false);
    setGroupDropdownOpen(false);
    setHighlightedIdx(-1);
  };

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
      const res = await shellService.testHostConnection(buildConfig());
      setTestResult(res);
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (connectAfter: boolean) => {
    if (!host.trim() || !username.trim()) return;
    setSaving(true);
    try {
      const saved = await shellService.saveHost(buildConfig());
      if (connectAfter) {
        await shellService.createSshSession({ hostId: saved.id, hostConfig: saved });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => shellService.closeHostModal()}
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
            onClick={() => shellService.closeHostModal()}
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
            <div ref={groupComboboxRef} className="block relative">
              <label htmlFor="host-form-group" className="text-[var(--text-muted)] block mb-1">
                Group
              </label>
              <div className="relative">
                <input
                  id="host-form-group"
                  type="text"
                  role="combobox"
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={showGroupDropdown}
                  aria-controls={existingGroups.length > 0 ? 'host-form-group-listbox' : undefined}
                  value={group}
                  onFocus={() => {
                    if (existingGroups.length > 0) {
                      setGroupFilterActive(false);
                      setGroupDropdownOpen(true);
                      setHighlightedIdx(-1);
                    }
                  }}
                  onChange={(e) => {
                    setGroup(e.target.value);
                    if (existingGroups.length > 0) {
                      setGroupFilterActive(true);
                      setGroupDropdownOpen(true);
                      setHighlightedIdx(-1);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' && existingGroups.length > 0) {
                      e.preventDefault();
                      if (!groupDropdownOpen) {
                        setGroupFilterActive(false);
                        setGroupDropdownOpen(true);
                        setHighlightedIdx(0);
                      } else if (filteredGroups.length > 0) {
                        setHighlightedIdx((prev) => (prev + 1) % filteredGroups.length);
                      }
                    } else if (e.key === 'ArrowUp' && showGroupDropdown) {
                      e.preventDefault();
                      setHighlightedIdx((prev) =>
                        prev <= 0 ? filteredGroups.length - 1 : prev - 1,
                      );
                    } else if (
                      e.key === 'Enter' &&
                      showGroupDropdown &&
                      highlightedIdx >= 0 &&
                      highlightedIdx < filteredGroups.length
                    ) {
                      e.preventDefault();
                      selectGroup(filteredGroups[highlightedIdx]);
                    } else if (e.key === 'Escape' && groupDropdownOpen) {
                      e.preventDefault();
                      e.stopPropagation();
                      setGroupDropdownOpen(false);
                      setHighlightedIdx(-1);
                    } else if (e.key === 'Tab') {
                      setGroupDropdownOpen(false);
                      setHighlightedIdx(-1);
                    }
                  }}
                  placeholder="Production"
                  className={`w-full h-8 ${
                    existingGroups.length > 0 ? 'pl-2.5 pr-8' : 'px-2.5'
                  } rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none`}
                />
                {existingGroups.length > 0 && (
                  <button
                    type="button"
                    aria-label="Toggle Existing Groups"
                    aria-expanded={showGroupDropdown}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (groupDropdownOpen) {
                        setGroupDropdownOpen(false);
                        setHighlightedIdx(-1);
                      } else {
                        setGroupFilterActive(false);
                        setGroupDropdownOpen(true);
                        setHighlightedIdx(-1);
                      }
                    }}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    <ChevronDown
                      className={`w-3.5 h-3.5 transition-transform ${
                        showGroupDropdown ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                )}
              </div>

              {showGroupDropdown && (
                <div
                  id="host-form-group-listbox"
                  role="listbox"
                  aria-label="Existing Groups"
                  className="absolute left-0 right-0 top-full mt-1 z-30 max-h-44 overflow-y-auto lighterm-scroll py-1 rounded-md border shadow-xl"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderColor: 'var(--border-subtle)',
                  }}
                >
                  {filteredGroups.map((opt, idx) => {
                    const isSelected = (group.trim() || 'Default') === opt;
                    const isHighlighted = idx === highlightedIdx;
                    return (
                      <button
                        key={opt}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setHighlightedIdx(idx)}
                        onClick={() => selectGroup(opt)}
                        className={`w-full px-2.5 py-1.5 flex items-center justify-between gap-2 text-left text-xs transition-colors ${
                          isHighlighted
                            ? 'bg-[var(--accent)]/20 text-[var(--text-primary)]'
                            : 'text-[var(--text-primary)] hover:bg-[var(--bg-app)]/70'
                        }`}
                      >
                        <span className="truncate">{opt}</span>
                        {isSelected && (
                          <Check className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
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
