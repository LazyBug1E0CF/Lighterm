import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  X,
} from 'lucide-react';
import { hasBackendRuntime, isWebRuntime } from '../../core/ipc';
import { updateService, useUpdateStore } from '../../core/updateService';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

function formatDate(raw?: string | null): string {
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return raw;
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return (
        <code
          key={idx}
          className="px-1 py-0.5 rounded font-mono text-[10px] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return (
        <strong key={idx} className="font-semibold text-[var(--text-primary)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <React.Fragment key={idx}>{part}</React.Fragment>;
  });
}

const COMMIT_PREFIX_RE = /^(feat|fix|perf|refactor|docs|chore|build|ci)(\([^)]+\))?:\s*/i;

function badgeClassForKind(kind: string): string {
  const lower = kind.toLowerCase();
  if (lower === 'feat') return 'bg-[var(--accent)]/18 text-[var(--accent)]';
  if (lower === 'fix') return 'bg-[var(--warning)]/18 text-[var(--warning)]';
  if (lower === 'perf') return 'bg-[var(--success)]/18 text-[var(--success)]';
  return 'bg-[var(--bg-elevated)] text-[var(--text-muted)]';
}

function renderReleaseBody(body: string): React.ReactNode {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)] italic">
        No release notes provided for this version.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {lines.map((line, idx) => {
        if (line.startsWith('### ') || line.startsWith('## ') || line.startsWith('# ')) {
          const title = line.replace(/^#{1,6}\s+/, '');
          return (
            <div
              key={idx}
              className="pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
            >
              {renderInlineMarkdown(title)}
            </div>
          );
        }

        const stripped = line.replace(/^[-*•]\s+/, '');
        const match = stripped.match(COMMIT_PREFIX_RE);
        if (match) {
          const kind = match[1].toLowerCase();
          const rest = stripped.slice(match[0].length);
          return (
            <div key={idx} className="flex items-start gap-2 text-[11px] leading-relaxed">
              <span
                className={`px-1.5 py-0 rounded font-mono text-[10px] font-semibold shrink-0 mt-0.5 ${badgeClassForKind(
                  kind,
                )}`}
              >
                {kind}
              </span>
              <span className="text-[var(--text-primary)]">{renderInlineMarkdown(rest)}</span>
            </div>
          );
        }

        return (
          <div key={idx} className="flex items-start gap-2 text-[11px] leading-relaxed">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-[var(--text-muted)] shrink-0" />
            <span className="text-[var(--text-primary)]">{renderInlineMarkdown(stripped)}</span>
          </div>
        );
      })}
    </div>
  );
}

export const UpdateModal: React.FC = () => {
  const open = useUpdateStore((s) => s.modalOpen);
  const result = useUpdateStore((s) => s.result);
  const downloadStatus = useUpdateStore((s) => s.downloadStatus);
  const progress = useUpdateStore((s) => s.progress);
  const downloaded = useUpdateStore((s) => s.downloaded);
  const downloadError = useUpdateStore((s) => s.downloadError);

  const [expandedTags, setExpandedTags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open || !result) return;
    const defaults: Record<string, boolean> = {};
    result.releases.forEach((rel, idx) => {
      defaults[rel.tagName] = idx < 3;
    });
    setExpandedTags(defaults);
  }, [open, result?.latestTag]);

  const isRestarting = downloadStatus === 'restarting';
  const isBusy =
    downloadStatus === 'downloading' || downloadStatus === 'verifying' || isRestarting;
  const webMode = isWebRuntime();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!isRestarting) {
          updateService.closeModal();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, isRestarting]);

  if (!open || !result || !result.hasUpdate) return null;

  const canDownloadInApp = Boolean(hasBackendRuntime() && result.canAutoDownload && result.asset);
  const releaseCount = result.releases.length;
  const pct = Math.max(0, Math.min(100, progress?.progressPercent ?? 0));
  const totalBytes = progress?.totalBytes || result.asset?.size || 0;
  const downloadedBytes = progress?.downloadedBytes ?? 0;
  const speedText =
    progress && progress.speedBytesPerSec > 0
      ? ` · ${formatBytes(progress.speedBytesPerSec)}/s`
      : '';

  const toggleRelease = (tagName: string) => {
    setExpandedTags((prev) => ({ ...prev, [tagName]: !prev[tagName] }));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={() => {
        if (!isRestarting) updateService.closeModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Update Available"
        onClick={(e) => e.stopPropagation()}
        className="lighterm-pop-enter w-full max-w-[560px] rounded-xl border shadow-2xl overflow-hidden flex flex-col max-h-[84vh]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        {/* Modal Header */}
        <div className="px-4 py-3 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-[var(--accent)]/15 text-[var(--accent)]">
              <Download className="w-4 h-4" />
            </div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
              Update Available
            </h2>
            <span className="px-2 py-0.5 rounded-md text-[11px] font-mono shrink-0 border border-[var(--border-subtle)] bg-[var(--bg-app)] text-[var(--accent)]">
              v{result.currentVersion} &rarr; v{result.latestVersion}
            </span>
          </div>

          <button
            type="button"
            disabled={isRestarting}
            onClick={() => updateService.closeModal()}
            aria-label="Close Update Dialog"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto lighterm-scroll p-4 space-y-3 text-xs">
          {/* Summary Banner */}
          <div className="p-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 flex items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-semibold text-[var(--text-primary)]">
                  v{result.latestVersion}
                </span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--success)]/20 text-[var(--success)]">
                  Latest
                </span>
                <span className="text-[11px] text-[var(--text-primary)]">
                  {releaseCount} {releaseCount === 1 ? 'release' : 'releases'} since v
                  {result.currentVersion}
                </span>
              </div>
              <div className="text-[11px] font-mono text-[var(--text-muted)] truncate">
                {result.publishedAt ? `Released ${formatDate(result.publishedAt)}` : 'GitHub Release'}
                {result.asset
                  ? ` · ${result.asset.name}${
                      result.asset.size > 0 ? ` · ${formatBytes(result.asset.size)}` : ''
                    }${result.asset.sha256Url ? ' · SHA-256' : ''}`
                  : ' · Download via GitHub Release'}
              </div>
            </div>

            <button
              type="button"
              onClick={() => void updateService.openReleasePage(result.releaseUrl)}
              className="h-7 px-2.5 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] text-[11px] font-medium flex items-center gap-1 shrink-0"
            >
              <span>GitHub</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>

          {/* Aggregated Multi-Version Timeline */}
          <div className="relative pl-4 space-y-2.5" aria-label="Aggregated Release Notes">
            <div className="absolute left-[5px] top-2 bottom-2 w-px bg-[var(--border-subtle)]" />

            {result.releases.map((rel) => {
              const isExpanded = expandedTags[rel.tagName] ?? rel.isLatest;
              const bodyId = `release-notes-${rel.tagName.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
              return (
                <div key={rel.tagName} className="relative" data-release-tag={rel.tagName}>
                  <span
                    className={`absolute -left-[15px] top-3 w-2.5 h-2.5 rounded-full border-2 ${
                      rel.isLatest
                        ? 'bg-[var(--accent)] border-[var(--accent)]'
                        : 'bg-[var(--bg-elevated)] border-[var(--border-subtle)]'
                    }`}
                  />
                  <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-app)]/55 overflow-hidden">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-controls={bodyId}
                      onClick={() => toggleRelease(rel.tagName)}
                      className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-[var(--bg-elevated)]/50 transition-colors"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono font-semibold text-xs text-[var(--text-primary)]">
                          {rel.tagName}
                        </span>
                        {rel.isLatest && (
                          <span className="px-1.5 py-0 rounded text-[10px] font-medium bg-[var(--accent)]/18 text-[var(--accent)]">
                            Latest
                          </span>
                        )}
                        {rel.publishedAt && (
                          <span className="text-[11px] font-mono text-[var(--text-muted)]">
                            {formatDate(rel.publishedAt)}
                          </span>
                        )}
                      </div>
                      <ChevronDown
                        className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform ${
                          isExpanded ? '' : '-rotate-90'
                        }`}
                      />
                    </button>

                    {isExpanded && (
                      <div
                        id={bodyId}
                        className="px-3 pb-2.5 pt-2 border-t border-[var(--border-subtle)]"
                      >
                        {renderReleaseBody(rel.body)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            <div className="relative flex items-center gap-2 pt-0.5 text-[11px] text-[var(--text-muted)]">
              <span className="absolute -left-[15px] w-2.5 h-2.5 rounded-full border-2 bg-[var(--bg-surface)] border-[var(--text-muted)]" />
              <span className="font-mono">Current installed version: v{result.currentVersion}</span>
            </div>
          </div>
        </div>

        {/* Conditional Progress / Ready / Restarting / Error Strip */}
        {(isBusy || downloadStatus === 'ready' || downloadStatus === 'error') && (
          <div className="px-4 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-app)]/60 text-xs shrink-0">
            {(downloadStatus === 'downloading' || downloadStatus === 'verifying') && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="flex items-center gap-2 font-medium">
                    <span
                      className={
                        downloadStatus === 'verifying'
                          ? 'text-[var(--success)]'
                          : 'text-[var(--accent)]'
                      }
                    >
                      1. Download
                    </span>
                    <span className="text-[var(--text-muted)]">&rarr;</span>
                    <span
                      className={
                        downloadStatus === 'verifying'
                          ? 'text-[var(--accent)]'
                          : 'text-[var(--text-muted)]'
                      }
                    >
                      2. Verify SHA-256
                    </span>
                    <span className="text-[var(--text-muted)]">&rarr;</span>
                    <span className="text-[var(--text-muted)]">
                      {webMode ? '3. Apply & Restart' : '3. Launch Installer'}
                    </span>
                  </div>
                  <span className="font-mono text-[var(--text-primary)]">
                    {downloadStatus === 'verifying'
                      ? 'Verifying SHA-256 checksum...'
                      : `${formatBytes(downloadedBytes)}${
                          totalBytes > 0 ? ` / ${formatBytes(totalBytes)}` : ''
                        } (${pct}%)${speedText}`}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full overflow-hidden bg-[var(--bg-elevated)]">
                  <div
                    className={`h-full rounded-full transition-all duration-150 ${
                      downloadStatus === 'verifying' ? 'bg-[var(--success)]' : 'bg-[var(--accent)]'
                    }`}
                    style={{ width: `${downloadStatus === 'verifying' ? 100 : pct}%` }}
                  />
                </div>
              </div>
            )}

            {downloadStatus === 'ready' && (
              <div className="px-3 py-2 rounded-md border border-[var(--success)]/45 bg-[var(--success)]/12 text-[var(--success)] flex items-center gap-2 text-[11px]">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>
                  {downloaded?.sha256Verified
                    ? webMode
                      ? `SHA-256 checksum verified. Ready to apply ${downloaded.assetName} and restart server.`
                      : `SHA-256 checksum verified. Ready to launch ${downloaded.assetName}.`
                    : webMode
                      ? `Download complete. Ready to apply ${
                          downloaded?.assetName ?? result.asset?.name ?? 'update'
                        } and restart server.`
                      : `Download complete. Ready to launch ${
                          downloaded?.assetName ?? result.asset?.name ?? 'installer'
                        }.`}
                </span>
              </div>
            )}

            {isRestarting && (
              <div
                role="status"
                className="px-3 py-2 rounded-md border border-[var(--accent)]/45 bg-[var(--accent)]/12 text-[var(--accent)] flex items-center justify-between gap-2 text-[11px]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                  <span>
                    Applying update and restarting server... Waiting for v{result.latestVersion} to
                    come back online. This page will reload automatically.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => updateService.reloadBrowserPage()}
                  className="px-2 py-1 rounded border border-[var(--accent)]/40 bg-[var(--bg-surface)] text-[var(--text-primary)] text-[10px] font-medium shrink-0"
                >
                  Reload Now
                </button>
              </div>
            )}

            {downloadStatus === 'error' && (
              <div
                role="alert"
                className="px-3 py-2 rounded-md border border-[var(--danger)]/45 bg-[var(--danger)]/12 text-[var(--danger)] flex items-center justify-between gap-2 text-[11px]"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="truncate">{downloadError ?? 'Update download failed.'}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {webMode && downloaded && (
                    <button
                      type="button"
                      onClick={() => updateService.reloadBrowserPage()}
                      className="px-2 py-1 rounded border border-[var(--danger)]/40 bg-[var(--bg-surface)] text-[var(--text-primary)] text-[10px] font-medium"
                    >
                      Reload Page
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void updateService.openReleasePage(result.releaseUrl)}
                    className="px-2 py-1 rounded border border-[var(--danger)]/40 bg-[var(--bg-surface)] text-[var(--text-primary)] text-[10px] font-medium flex items-center gap-1"
                  >
                    <span>Open Release Page</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Modal Footer */}
        <div className="px-4 py-3 flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-app)]/50 text-xs shrink-0">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void updateService.skipCurrentVersion()}
            className="h-8 px-2.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] disabled:opacity-40 transition-colors"
          >
            Skip This Version
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isRestarting}
              onClick={() => {
                if (downloadStatus === 'downloading' || downloadStatus === 'verifying') {
                  void updateService.cancelDownload();
                } else if (!isRestarting) {
                  updateService.closeModal();
                }
              }}
              className="h-8 px-3 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] disabled:opacity-40 transition-colors"
            >
              {downloadStatus === 'downloading' || downloadStatus === 'verifying'
                ? 'Cancel Download'
                : 'Cancel'}
            </button>

            {downloadStatus === 'ready' ? (
              <button
                type="button"
                onClick={() => void updateService.installDownloadedUpdate()}
                className="h-8 px-3.5 rounded-md font-medium bg-[var(--success)] text-[#0f111a] hover:opacity-90 flex items-center gap-1.5"
              >
                Install &amp; Restart
              </button>
            ) : isBusy ? (
              <button
                type="button"
                disabled
                className="h-8 px-3.5 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] opacity-60 flex items-center gap-1.5"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>
                  {isRestarting
                    ? 'Restarting...'
                    : downloadStatus === 'verifying'
                      ? 'Verifying...'
                      : 'Downloading...'}
                </span>
              </button>
            ) : canDownloadInApp ? (
              <button
                type="button"
                onClick={() => void updateService.startDownload()}
                className="h-8 px-3.5 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 flex items-center gap-1.5"
              >
                {downloadStatus === 'error' ? 'Retry Update' : 'Update Now'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void updateService.openReleasePage(result.releaseUrl)}
                className="h-8 px-3.5 rounded-md font-medium bg-[var(--accent)] text-[#0f111a] hover:opacity-90 flex items-center gap-1.5"
              >
                <span>Open Release Page</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
