import { create } from 'zustand';
import {
  hasBackendRuntime,
  invokeBackend,
  isWebRuntime,
  listenBackend,
  makeUuid,
} from '../../core/ipc';
import { webSftpDownload, webSftpUpload } from '../../core/webTransport';
import { pluginKernel } from '../../kernel/PluginKernel';
import type { SftpEntry, SftpTransferProgress } from '../../types';

export interface SftpPluginConfig extends Record<string, unknown> {
  showHiddenByDefault: boolean;
  defaultRemotePath: string;
}

export const DEFAULT_SFTP_CONFIG: SftpPluginConfig = {
  showHiddenByDefault: false,
  defaultRemotePath: '.',
};

interface MockFsNode {
  name: string;
  isDir: boolean;
  size: number;
  mode: number;
  permissions: string;
  modifiedAt: number;
}

const mockSftpTrees = new Map<string, Map<string, MockFsNode[]>>();

function getMockSftpTree(hostId: string): Map<string, MockFsNode[]> {
  let tree = mockSftpTrees.get(hostId);
  if (!tree) {
    const now = Math.floor(Date.now() / 1000);
    tree = new Map<string, MockFsNode[]>([
      [
        '/home/deploy',
        [
          {
            name: 'app',
            isDir: true,
            size: 4096,
            mode: 0o755,
            permissions: 'drwxr-xr-x',
            modifiedAt: now - 3600,
          },
          {
            name: '.ssh',
            isDir: true,
            size: 4096,
            mode: 0o700,
            permissions: 'drwx------',
            modifiedAt: now - 86400,
          },
          {
            name: 'docker-compose.yml',
            isDir: false,
            size: 1842,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 1800,
          },
          {
            name: '.env',
            isDir: false,
            size: 320,
            mode: 0o600,
            permissions: '-rw-------',
            modifiedAt: now - 7200,
          },
        ],
      ],
      [
        '/home/deploy/app',
        [
          {
            name: 'server.log',
            isDir: false,
            size: 48120,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 120,
          },
          {
            name: 'config.toml',
            isDir: false,
            size: 912,
            mode: 0o644,
            permissions: '-rw-r--r--',
            modifiedAt: now - 4000,
          },
        ],
      ],
    ]);
    mockSftpTrees.set(hostId, tree);
  }
  return tree;
}

export interface SftpStoreState {
  hostId: string | null;
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  transfers: SftpTransferProgress[];
}

export const useSftpPluginStore = create<SftpStoreState>(() => ({
  hostId: null,
  path: '.',
  entries: [],
  loading: false,
  error: null,
  showHidden: false,
  transfers: [],
}));

function pushProgress(progress: SftpTransferProgress): void {
  useSftpPluginStore.setState((state) => {
    const idx = state.transfers.findIndex((t) => t.transferId === progress.transferId);
    const next = [...state.transfers];
    if (idx >= 0) next[idx] = progress;
    else next.unshift(progress);
    return { transfers: next.slice(0, 8) };
  });
}

export async function subscribeSftpProgressEvents(): Promise<() => void> {
  if (!hasBackendRuntime()) return () => {};
  return listenBackend<SftpTransferProgress>('sftp:progress', (payload) => {
    pushProgress(payload);
  });
}

export const sftpClient = {
  async canonicalize(hostId: string, path: string): Promise<string> {
    if (hasBackendRuntime()) {
      return invokeBackend<string>('sftp_canonicalize', { hostId, path });
    }
    if (!path || path === '.') return '/home/deploy';
    return path.startsWith('/') ? path : `/home/deploy/${path}`;
  },

  async listDir(hostId: string, path: string): Promise<SftpEntry[]> {
    if (hasBackendRuntime()) {
      return invokeBackend<SftpEntry[]>('sftp_list_dir', { hostId, path });
    }
    const tree = getMockSftpTree(hostId);
    const items = tree.get(path) ?? [];
    return items
      .map((item) => ({
        name: item.name,
        path: path === '/' ? `/${item.name}` : `${path.replace(/\/+$/, '')}/${item.name}`,
        isDir: item.isDir,
        isSymlink: false,
        size: item.size,
        permissions: item.permissions,
        mode: item.mode,
        modifiedAt: item.modifiedAt,
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  },

  async openForHost(hostId: string, initialPath?: string): Promise<void> {
    const targetPath =
      initialPath ??
      (pluginKernel.getPluginConfig('lighterm.sftp', DEFAULT_SFTP_CONFIG).defaultRemotePath ||
        '.');
    useSftpPluginStore.setState({ hostId, loading: true, error: null });
    try {
      const canonical = await this.canonicalize(hostId, targetPath);
      const entries = await this.listDir(hostId, canonical);
      useSftpPluginStore.setState({ path: canonical, entries, loading: false });
    } catch (err) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err);
      useSftpPluginStore.setState({ loading: false, error: msg });
    }
  },

  async navigate(path: string): Promise<void> {
    const hostId = useSftpPluginStore.getState().hostId;
    if (!hostId) return;
    await this.openForHost(hostId, path);
  },

  async refresh(): Promise<void> {
    const { hostId, path } = useSftpPluginStore.getState();
    if (!hostId) return;
    await this.openForHost(hostId, path);
  },

  setShowHidden(showHidden: boolean): void {
    useSftpPluginStore.setState({ showHidden });
  },

  toggleHidden(): void {
    useSftpPluginStore.setState((s) => ({ showHidden: !s.showHidden }));
  },

  async mkdir(name: string): Promise<void> {
    const { hostId, path } = useSftpPluginStore.getState();
    if (!hostId || !name.trim()) return;
    const clean = name.trim().replace(/^\/+|\/+$/g, '');
    const target = path === '/' ? `/${clean}` : `${path.replace(/\/+$/, '')}/${clean}`;
    if (hasBackendRuntime()) {
      await invokeBackend<void>('sftp_mkdir', { hostId, path: target });
    } else {
      const tree = getMockSftpTree(hostId);
      const lastSlash = target.lastIndexOf('/');
      const parent = lastSlash <= 0 ? '/' : target.slice(0, lastSlash);
      const list = tree.get(parent) ?? [];
      if (!list.some((e) => e.name === clean)) {
        list.push({
          name: clean,
          isDir: true,
          size: 4096,
          mode: 0o755,
          permissions: 'drwxr-xr-x',
          modifiedAt: Math.floor(Date.now() / 1000),
        });
        tree.set(parent, list);
        tree.set(target, []);
      }
    }
    await this.refresh();
  },

  async remove(entry: SftpEntry): Promise<void> {
    const { hostId } = useSftpPluginStore.getState();
    if (!hostId) return;
    if (hasBackendRuntime()) {
      await invokeBackend<void>('sftp_remove', { hostId, path: entry.path, isDir: entry.isDir });
    } else {
      const tree = getMockSftpTree(hostId);
      const lastSlash = entry.path.lastIndexOf('/');
      const parent = lastSlash <= 0 ? '/' : entry.path.slice(0, lastSlash);
      const list = (tree.get(parent) ?? []).filter((e) => e.name !== entry.name);
      tree.set(parent, list);
      if (entry.isDir) tree.delete(entry.path);
    }
    await this.refresh();
  },

  async rename(entry: SftpEntry, newName: string): Promise<void> {
    const { hostId, path } = useSftpPluginStore.getState();
    if (!hostId || !newName.trim()) return;
    const clean = newName.trim().replace(/\//g, '');
    const nextPath = path === '/' ? `/${clean}` : `${path.replace(/\/+$/, '')}/${clean}`;
    if (hasBackendRuntime()) {
      await invokeBackend<void>('sftp_rename', { hostId, oldPath: entry.path, newPath: nextPath });
    } else {
      const tree = getMockSftpTree(hostId);
      const oldSlash = entry.path.lastIndexOf('/');
      const parent = oldSlash <= 0 ? '/' : entry.path.slice(0, oldSlash);
      const list = tree.get(parent) ?? [];
      const item = list.find((e) => e.name === entry.name);
      if (item) item.name = clean;
    }
    await this.refresh();
  },

  async upload(localPath: string, fileName: string): Promise<void> {
    const { hostId, path } = useSftpPluginStore.getState();
    if (!hostId) return;
    const remotePath = path === '/' ? `/${fileName}` : `${path.replace(/\/+$/, '')}/${fileName}`;
    if (hasBackendRuntime()) {
      await invokeBackend<void>('sftp_upload', { hostId, localPath, remotePath });
    } else {
      pushProgress({
        transferId: makeUuid(),
        hostId,
        fileName,
        direction: 'upload',
        bytesTransferred: 1024,
        totalBytes: 1024,
        done: true,
        error: null,
      });
      const tree = getMockSftpTree(hostId);
      const lastSlash = remotePath.lastIndexOf('/');
      const parent = lastSlash <= 0 ? '/' : remotePath.slice(0, lastSlash);
      const list = tree.get(parent) ?? [];
      list.push({
        name: fileName,
        isDir: false,
        size: 1024,
        mode: 0o644,
        permissions: '-rw-r--r--',
        modifiedAt: Math.floor(Date.now() / 1000),
      });
      tree.set(parent, list);
    }
    await this.refresh();
  },

  async uploadFile(file: File): Promise<void> {
    const { hostId, path } = useSftpPluginStore.getState();
    if (!hostId) return;
    const remotePath = path === '/' ? `/${file.name}` : `${path.replace(/\/+$/, '')}/${file.name}`;
    if (isWebRuntime()) {
      await webSftpUpload(hostId, remotePath, file);
      await this.refresh();
      return;
    }
    await this.upload(file.name, file.name);
  },

  async download(entry: SftpEntry, localPath: string): Promise<void> {
    const { hostId } = useSftpPluginStore.getState();
    if (!hostId) return;
    if (isWebRuntime()) {
      await webSftpDownload(hostId, entry.path, entry.name, entry.size);
      return;
    }
    if (hasBackendRuntime()) {
      await invokeBackend<void>('sftp_download', {
        hostId,
        remotePath: entry.path,
        localPath,
      });
    } else {
      pushProgress({
        transferId: makeUuid(),
        hostId,
        fileName: entry.name,
        direction: 'download',
        bytesTransferred: 2048,
        totalBytes: 2048,
        done: true,
        error: null,
      });
    }
  },
};
