import React, { useMemo, useState } from 'react';
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { pickOpenFile, pickSaveFile } from '../../services/backend';
import { useAppStore } from '../../store/useAppStore';
import type { SftpEntry } from '../../types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = bytes / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(1)} ${units[idx]}`;
}

export const SftpDrawer: React.FC = () => {
  const sftpOpen = useAppStore((s) => s.sftpOpen);
  const hosts = useAppStore((s) => s.hosts);
  const sftpHostId = useAppStore((s) => s.sftpHostId);
  const sftpPath = useAppStore((s) => s.sftpPath);
  const sftpEntries = useAppStore((s) => s.sftpEntries);
  const sftpLoading = useAppStore((s) => s.sftpLoading);
  const sftpError = useAppStore((s) => s.sftpError);
  const sftpShowHidden = useAppStore((s) => s.sftpShowHidden);
  const sftpTransfers = useAppStore((s) => s.sftpTransfers);

  const toggleSftpDrawer = useAppStore((s) => s.toggleSftpDrawer);
  const openSftpForHost = useAppStore((s) => s.openSftpForHost);
  const navigateSftp = useAppStore((s) => s.navigateSftp);
  const refreshSftp = useAppStore((s) => s.refreshSftp);
  const toggleSftpHidden = useAppStore((s) => s.toggleSftpHidden);
  const mkdirSftp = useAppStore((s) => s.mkdirSftp);
  const removeSftp = useAppStore((s) => s.removeSftp);
  const renameSftp = useAppStore((s) => s.renameSftp);
  const uploadSftp = useAppStore((s) => s.uploadSftp);
  const downloadSftp = useAppStore((s) => s.downloadSftp);
  const sendTextToActivePane = useAppStore((s) => s.sendTextToActivePane);

  const [pathDraft, setPathDraft] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renamingEntry, setRenamingEntry] = useState<SftpEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const visibleEntries = useMemo(() => {
    if (sftpShowHidden) return sftpEntries;
    return sftpEntries.filter((e) => !e.name.startsWith('.'));
  }, [sftpEntries, sftpShowHidden]);

  const breadcrumbs = useMemo(() => {
    const parts = sftpPath.split('/').filter(Boolean);
    const crumbs: { label: string; path: string }[] = [{ label: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }, [sftpPath]);

  if (!sftpOpen) return null;

  const goParent = () => {
    if (sftpPath === '/' || sftpPath === '.') return;
    const idx = sftpPath.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : sftpPath.slice(0, idx);
    void navigateSftp(parent);
  };

  const handleUpload = async () => {
    if (!sftpHostId) return;
    const picked = await pickOpenFile('Upload File via SFTP');
    const localPath = picked ?? window.prompt('Local file path to upload:');
    if (!localPath) return;
    const fileName = localPath.split(/[/\\]/).pop() || 'upload.bin';
    await uploadSftp(localPath, fileName);
  };

  const handleDownload = async (entry: SftpEntry) => {
    const picked = await pickSaveFile('Save Remote File', entry.name);
    const localPath = picked ?? window.prompt('Save to local path:', `./${entry.name}`);
    if (!localPath) return;
    await downloadSftp(entry, localPath);
  };

  const latestTransfer = sftpTransfers[0];

  return (
    <section
      aria-label="SFTP File Browser"
      className="h-64 shrink-0 border-t flex flex-col text-xs"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Top Toolbar */}
      <div className="h-9 px-3 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-[var(--accent)] shrink-0">SFTP</span>
          <select
            aria-label="SFTP Host"
            value={sftpHostId ?? ''}
            onChange={(e) => {
              if (e.target.value) void openSftpForHost(e.target.value);
            }}
            className="h-6 px-2 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none max-w-[180px]"
          >
            <option value="">Select SSH Host...</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name || `${h.username}@${h.host}`}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={goParent}
            title="Up One Directory"
            disabled={!sftpHostId || sftpPath === '/'}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] disabled:opacity-35"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>

          {/* Breadcrumbs & Path Go */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (pathDraft.trim()) {
                void navigateSftp(pathDraft.trim());
                setPathDraft('');
              }
            }}
            className="flex items-center gap-1 min-w-0"
          >
            <div className="hidden md:flex items-center gap-0.5 text-[11px] font-mono overflow-x-auto max-w-[260px]">
              {breadcrumbs.map((c, idx) => (
                <React.Fragment key={c.path}>
                  {idx > 0 && <span className="text-[var(--text-muted)]">/</span>}
                  <button
                    type="button"
                    onClick={() => void navigateSftp(c.path)}
                    className="px-1 rounded hover:bg-[var(--bg-elevated)] text-[var(--text-primary)] truncate"
                  >
                    {c.label === '/' ? 'root' : c.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
            <input
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              placeholder={sftpPath}
              className="w-36 h-6 px-2 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] font-mono text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
            />
          </form>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={!sftpHostId}
            className="h-6 px-2 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] hover:border-[var(--accent)] border border-[var(--border-subtle)] disabled:opacity-40 flex items-center gap-1"
          >
            <Upload className="w-3 h-3" />
            <span>Upload</span>
          </button>
          <button
            type="button"
            onClick={() => setMkdirOpen((v) => !v)}
            disabled={!sftpHostId}
            className="h-6 px-2 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-subtle)] disabled:opacity-40 flex items-center gap-1"
          >
            <FolderPlus className="w-3 h-3" />
            <span>New Folder</span>
          </button>
          <button
            type="button"
            onClick={toggleSftpHidden}
            title={sftpShowHidden ? 'Hide Dotfiles' : 'Show Dotfiles'}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            {sftpShowHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => void refreshSftp()}
            disabled={!sftpHostId}
            title="Refresh"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${sftpLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => void toggleSftpDrawer()}
            aria-label="Close SFTP"
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Inline New Folder Input */}
      {mkdirOpen && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newFolderName.trim()) return;
            await mkdirSftp(newFolderName);
            setNewFolderName('');
            setMkdirOpen(false);
          }}
          className="px-3 py-1.5 flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--bg-app)]/70"
        >
          <span className="text-[var(--text-muted)]">Folder name:</span>
          <input
            type="text"
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="new-folder"
            className="h-6 px-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="submit"
            className="h-6 px-2.5 rounded bg-[var(--accent)] text-[#0f111a] font-medium"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => setMkdirOpen(false)}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
        </form>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto lighterm-scroll">
        {!sftpHostId ? (
          <div className="h-full flex items-center justify-center text-[var(--text-muted)]">
            {hosts.length === 0
              ? 'Save an SSH host first to browse remote files over SFTP.'
              : 'Select an SSH host above to browse its remote filesystem.'}
          </div>
        ) : sftpError ? (
          <div className="p-4 text-[var(--danger)]">SFTP Error: {sftpError}</div>
        ) : sftpLoading && visibleEntries.length === 0 ? (
          <div className="h-full flex items-center justify-center gap-2 text-[var(--text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading directory...
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] text-[10px] uppercase text-[var(--text-muted)]">
              <tr>
                <th className="py-1.5 px-3 font-medium">Name</th>
                <th className="py-1.5 px-2 font-medium w-24">Size</th>
                <th className="py-1.5 px-2 font-medium w-28">Permissions</th>
                <th className="py-1.5 px-2 font-medium w-36">Modified</th>
                <th className="py-1.5 px-3 font-medium w-28 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]/40">
              {visibleEntries.map((entry) => (
                <tr
                  key={entry.path}
                  onDoubleClick={() => {
                    if (entry.isDir) void navigateSftp(entry.path);
                  }}
                  className="group hover:bg-[var(--bg-elevated)]/60"
                >
                  <td className="py-1.5 px-3">
                    <div className="flex items-center gap-2">
                      {entry.isDir ? (
                        <Folder className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                      ) : (
                        <FileIcon className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                      )}
                      {renamingEntry?.path === entry.path ? (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (renameDraft.trim()) {
                              await renameSftp(entry, renameDraft);
                            }
                            setRenamingEntry(null);
                          }}
                        >
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => setRenamingEntry(null)}
                            className="h-5 px-1.5 rounded bg-[var(--bg-app)] border border-[var(--accent)] text-[var(--text-primary)] outline-none"
                          />
                        </form>
                      ) : (
                        <span
                          className={`truncate ${
                            entry.isDir
                              ? 'text-[var(--text-primary)] font-medium cursor-pointer'
                              : 'text-[var(--text-primary)]'
                          }`}
                        >
                          {entry.name}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 px-2 font-mono text-[11px] text-[var(--text-muted)]">
                    {entry.isDir ? '—' : formatBytes(entry.size)}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-[11px] text-[var(--text-muted)]">
                    {entry.permissions}
                  </td>
                  <td className="py-1.5 px-2 text-[11px] text-[var(--text-muted)]">
                    {entry.modifiedAt
                      ? new Date(entry.modifiedAt * 1000).toLocaleString()
                      : '—'}
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    <div className="inline-flex items-center gap-1 opacity-75 group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => void sendTextToActivePane(entry.path, false)}
                        title="Insert Remote Path into Terminal"
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        <Terminal className="w-3 h-3" />
                      </button>
                      {!entry.isDir && (
                        <button
                          type="button"
                          onClick={() => void handleDownload(entry)}
                          title="Download"
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--accent)]"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setRenamingEntry(entry);
                          setRenameDraft(entry.name);
                        }}
                        title="Rename"
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeSftp(entry)}
                        title="Delete"
                        className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)]"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Transfer Progress Strip */}
      {latestTransfer && (
        <div className="h-6 px-3 flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--bg-app)]/70 text-[11px]">
          <span className="truncate text-[var(--text-muted)]">
            {latestTransfer.direction === 'upload' ? 'Uploading' : 'Downloading'}{' '}
            <strong className="text-[var(--text-primary)]">{latestTransfer.fileName}</strong>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-28 h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent)] transition-all"
                style={{
                  width: `${
                    latestTransfer.totalBytes > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (latestTransfer.bytesTransferred / latestTransfer.totalBytes) * 100,
                          ),
                        )
                      : 100
                  }%`,
                }}
              />
            </div>
            <span className="text-[var(--text-muted)] font-mono">
              {latestTransfer.done ? 'Done' : formatBytes(latestTransfer.bytesTransferred)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
};
