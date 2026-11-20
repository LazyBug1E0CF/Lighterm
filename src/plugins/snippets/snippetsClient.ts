import { create } from 'zustand';
import { invokeTauri, isTauriRuntime, makeUuid, readLs, writeLs } from '../../core/ipc';
import type { Snippet } from '../../types';

const LS_SNIPPETS = 'lighterm:snippets';

function createStarterSnippets(): Snippet[] {
  const now = Date.now();
  return [
    {
      id: 'snip-df',
      title: 'Disk Usage (Human)',
      command: 'df -h',
      category: 'System',
      description: 'Show mounted filesystem disk usage',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-ss',
      title: 'Listening Ports',
      command: 'ss -tulpn',
      category: 'Network',
      description: 'List listening TCP/UDP sockets',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-docker',
      title: 'Docker Containers',
      command: "docker ps --format 'table {{.Names}}\\t{{.Status}}\\t{{.Ports}}'",
      category: 'Docker',
      description: 'Compact running container status table',
      autoExecute: true,
      updatedAt: now,
    },
    {
      id: 'snip-logs',
      title: 'Follow Service Logs',
      command: 'journalctl -u {{service}} -f -n 100',
      category: 'System',
      description: 'Tail systemd logs for a service',
      autoExecute: false,
      updatedAt: now,
    },
  ];
}

export const useSnippetsPluginStore = create<{ snippets: Snippet[] }>(() => ({
  snippets: [],
}));

const changeListeners = new Set<(snippets: Snippet[]) => void>();

export const snippetsClient = {
  onChange(cb: (snippets: Snippet[]) => void): () => void {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  },

  async load(): Promise<Snippet[]> {
    const snippets = isTauriRuntime()
      ? await invokeTauri<Snippet[]>('snippets_list')
      : readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets);
    useSnippetsPluginStore.setState({ snippets });
    changeListeners.forEach((cb) => cb(snippets));
    return snippets;
  },

  async save(snippet: Snippet): Promise<Snippet> {
    let saved: Snippet;
    if (isTauriRuntime()) {
      saved = await invokeTauri<Snippet>('snippets_save', { snippet });
    } else {
      const list = readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets);
      saved = {
        ...snippet,
        id: snippet.id.trim() ? snippet.id : makeUuid(),
        updatedAt: Date.now(),
      };
      const idx = list.findIndex((s) => s.id === saved.id);
      if (idx >= 0) list[idx] = saved;
      else list.push(saved);
      writeLs(LS_SNIPPETS, list);
    }
    await this.load();
    return saved;
  },

  async remove(id: string): Promise<void> {
    if (isTauriRuntime()) {
      await invokeTauri<void>('snippets_delete', { id });
    } else {
      const list = readLs<Snippet[]>(LS_SNIPPETS, createStarterSnippets).filter((s) => s.id !== id);
      writeLs(LS_SNIPPETS, list);
    }
    await this.load();
  },
};
