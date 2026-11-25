import React, { useEffect, useMemo, useState } from 'react';
import { CornerDownLeft, Pencil, Play, Plus, Search, Trash2, X } from 'lucide-react';
import { shellService } from '../../core/shellService';
import { usePluginConfig } from '../../kernel';
import type { ViewportComponentProps } from '../../kernel/types';
import type { Snippet } from '../../types';
import {
  DEFAULT_SNIPPETS_CONFIG,
  snippetsClient,
  useSnippetsPluginStore,
} from './snippetsClient';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function extractPlaceholders(command: string): string[] {
  const vars = new Set<string>();
  for (const match of command.matchAll(PLACEHOLDER_RE)) {
    if (match[1]) vars.add(match[1]);
  }
  return Array.from(vars);
}

export const SnippetsViewport: React.FC<ViewportComponentProps> = () => {
  const snippets = useSnippetsPluginStore((s) => s.snippets);
  const { config: snippetsConfig } = usePluginConfig(
    'lighterm.snippets',
    DEFAULT_SNIPPETS_CONFIG,
  );

  useEffect(() => {
    void snippetsClient.load();
  }, []);

  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  const [title, setTitle] = useState('');
  const [command, setCommand] = useState('');
  const [category, setCategory] = useState(snippetsConfig.defaultCategory);
  const [autoExecute, setAutoExecute] = useState(snippetsConfig.defaultAutoExecute);

  const [pendingSnippet, setPendingSnippet] = useState<{
    snippet: Snippet;
    execute: boolean;
    vars: string[];
    values: Record<string, string>;
  } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    );
  }, [snippets, query]);

  const openEditor = (snip?: Snippet) => {
    if (snip) {
      setEditing(snip);
      setTitle(snip.title);
      setCommand(snip.command);
      setCategory(snip.category);
      setAutoExecute(snip.autoExecute);
    } else {
      setEditing(null);
      setTitle('');
      setCommand('');
      setCategory(snippetsConfig.defaultCategory || 'General');
      setAutoExecute(Boolean(snippetsConfig.defaultAutoExecute));
    }
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !command.trim()) return;
    await snippetsClient.save({
      id: editing?.id ?? '',
      title: title.trim(),
      command: command.trim(),
      category: category.trim() || 'General',
      description: editing?.description ?? null,
      autoExecute,
      updatedAt: Date.now(),
    });
    setFormOpen(false);
  };

  const triggerSnippet = async (snippet: Snippet, execute: boolean) => {
    const vars = extractPlaceholders(snippet.command);
    if (vars.length > 0) {
      const initial: Record<string, string> = {};
      vars.forEach((v) => {
        initial[v] = '';
      });
      setPendingSnippet({ snippet, execute, vars, values: initial });
      return;
    }
    await shellService.sendTextToActiveSession(snippet.command, execute);
  };

  const submitPlaceholderSnippet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingSnippet) return;
    let resolved = pendingSnippet.snippet.command;
    for (const key of pendingSnippet.vars) {
      const val = pendingSnippet.values[key] ?? '';
      resolved = resolved.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), val);
    }
    await shellService.sendTextToActiveSession(resolved, pendingSnippet.execute);
    setPendingSnippet(null);
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-2.5 flex items-center gap-1.5 border-b border-[var(--border-subtle)] shrink-0">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter snippets..."
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => openEditor()}
          aria-label="New Snippet"
          className="h-7 px-2 rounded-md text-xs font-medium flex items-center gap-1 bg-[var(--accent)] text-[#0f111a] hover:opacity-90 shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New</span>
        </button>
      </div>

      {formOpen && (
        <form
          onSubmit={handleSave}
          className="p-2.5 border-b border-[var(--border-subtle)] bg-[var(--bg-app)]/70 space-y-2 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--text-primary)]">
              {editing ? 'Edit Snippet' : 'New Snippet'}
            </span>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (e.g. Tail Nginx)"
            className="w-full h-7 px-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Category (e.g. Docker)"
            className="w-full h-7 px-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <textarea
            rows={2}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Command (supports {{var}} placeholders)"
            className="w-full p-2 rounded bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono text-[11px] outline-none focus:border-[var(--accent)]"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={autoExecute}
                onChange={(e) => setAutoExecute(e.target.checked)}
              />
              Auto-execute
            </label>
            <button
              type="submit"
              className="h-6 px-2.5 rounded bg-[var(--accent)] text-[#0f111a] font-medium"
            >
              Save
            </button>
          </div>
        </form>
      )}

      {pendingSnippet && (
        <form
          onSubmit={submitPlaceholderSnippet}
          className="p-2.5 border-b border-[var(--accent)]/40 bg-[var(--accent)]/10 space-y-2 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--accent)]">
              Fill variables: {pendingSnippet.snippet.title}
            </span>
            <button
              type="button"
              onClick={() => setPendingSnippet(null)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {pendingSnippet.vars.map((v) => (
            <input
              key={v}
              type="text"
              autoFocus={v === pendingSnippet.vars[0]}
              value={pendingSnippet.values[v] ?? ''}
              onChange={(e) =>
                setPendingSnippet((prev) =>
                  prev ? { ...prev, values: { ...prev.values, [v]: e.target.value } } : null,
                )
              }
              placeholder={v}
              className="w-full h-7 px-2 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] font-mono outline-none focus:border-[var(--accent)]"
            />
          ))}
          <button
            type="submit"
            className="w-full h-7 rounded bg-[var(--accent)] text-[#0f111a] font-medium"
          >
            {pendingSnippet.execute ? 'Run Command' : 'Insert Command'}
          </button>
        </form>
      )}

      <div className="flex-1 overflow-y-auto lighterm-scroll p-2 space-y-1.5">
        {filtered.map((snip) => (
          <div
            key={snip.id}
            className="group p-2 rounded-md border border-[var(--border-subtle)]/60 bg-[var(--bg-app)]/50 hover:border-[var(--accent)]/50 transition-colors"
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                {snip.title}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)] shrink-0">
                {snip.category}
              </span>
            </div>
            <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)] truncate">
              {snip.command}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void triggerSnippet(snip, true)}
                  title="Execute in Active Shell"
                  className="px-2 py-0.5 rounded text-[10px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] hover:bg-[var(--accent)]/25 flex items-center gap-1"
                >
                  <Play className="w-2.5 h-2.5" />
                  Run
                </button>
                <button
                  type="button"
                  onClick={() => void triggerSnippet(snip, false)}
                  title="Insert without running"
                  className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1"
                >
                  <CornerDownLeft className="w-2.5 h-2.5" />
                  Insert
                </button>
              </div>
              <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() => openEditor(snip)}
                  aria-label={`Edit ${snip.title}`}
                  className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <Pencil className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void snippetsClient.remove(snip.id)}
                  aria-label={`Delete ${snip.title}`}
                  className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--danger)]"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
