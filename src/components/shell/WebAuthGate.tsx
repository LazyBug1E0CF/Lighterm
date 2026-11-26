import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, Terminal } from 'lucide-react';
import { useWebAuthStore, webAuth } from '../../core/webTransport';

export const WebAuthGate: React.FC = () => {
  const usernameRequired = useWebAuthStore((s) => s.usernameRequired);
  const checking = useWebAuthStore((s) => s.checking);
  const error = useWebAuthStore((s) => s.error);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setLocalError('Password is required.');
      return;
    }
    if (usernameRequired && !username.trim()) {
      setLocalError('Username is required.');
      return;
    }
    setLocalError(null);
    try {
      await webAuth.login(password, usernameRequired ? username.trim() : undefined);
    } catch {
      // Store error is populated by webAuth.login
    }
  };

  const displayError = localError ?? error;

  return (
    <div
      className="w-screen h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      <div
        role="dialog"
        aria-label="Lighterm Web Sign In"
        className="w-full max-w-sm rounded-xl border shadow-2xl overflow-hidden"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="px-5 py-4 border-b border-[var(--border-subtle)] flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-mono text-xs font-bold shrink-0"
            style={{ backgroundColor: 'var(--accent)', color: '#0f111a' }}
          >
            &gt;_
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
              <span>Lighterm Web</span>
              <Lock className="w-3.5 h-3.5 text-[var(--accent)]" />
            </h1>
            <p className="text-[11px] text-[var(--text-muted)]">
              Sign in to access your terminal &amp; SSH workbench
            </p>
          </div>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-3.5 text-xs">
          {usernameRequired && (
            <label className="block">
              <span className="text-[var(--text-muted)] block mb-1">Username</span>
              <input
                type="text"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username"
                className="w-full h-9 px-3 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
            </label>
          )}

          <label className="block">
            <span className="text-[var(--text-muted)] block mb-1">Password</span>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                autoFocus={!usernameRequired}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter server access password"
                className="w-full h-9 pl-3 pr-9 rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent)] outline-none"
              />
              <button
                type="button"
                aria-label={showPassword ? 'Hide Password' : 'Show Password'}
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </label>

          {displayError && (
            <div
              role="alert"
              className="px-3 py-2 rounded-md border border-[var(--danger)]/40 bg-[var(--danger)]/10 text-[var(--danger)] text-[11px]"
            >
              {displayError}
            </div>
          )}

          <button
            type="submit"
            disabled={checking}
            className="w-full h-9 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition-opacity"
          >
            {checking ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Terminal className="w-4 h-4" />
            )}
            <span>{checking ? 'Signing in…' : 'Sign In'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
