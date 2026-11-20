import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Columns2,
  Copy,
  PictureInPicture2,
  Rows2,
  Search,
  Trash2,
} from 'lucide-react';
import { shellService, useShellStore } from '../../core/shellService';
import { useHarness } from '../../harness/HarnessContext';
import type { ViewportComponentProps } from '../../harness/types';
import { layoutService } from '../../layout/layoutStore';
import { getThemePreset, hexWithAlpha } from '../../themes/presets';
import { base64ToBytes, utf8ToBase64 } from '../../utils/base64';
import { matchesShortcut } from '../../utils/shortcuts';
import { TerminalPluginService, useTerminalPluginStore } from './terminalService';

export const TerminalViewport: React.FC<ViewportComponentProps> = ({
  viewport,
  isActive,
  isFloating,
}) => {
  const harness = useHarness();
  const sessionId = String(viewport.params?.sessionId ?? '');
  const settings = useShellStore((s) => s.settings);
  const status = useShellStore((s) => s.sessionStatuses[sessionId] ?? 'connected');
  const statusMsg = useShellStore((s) => s.sessionMessages[sessionId]);
  const searchSignal = useTerminalPluginStore((s) => s.searchSignal);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const theme = useMemo(() => getThemePreset(settings.themeId), [settings.themeId]);
  const termService = harness.getService<TerminalPluginService>('terminal:service');

  // Mount xterm instance for this sessionId.
  // Never closes backend session on unmount so dragging/docking/floating preserves the shell!
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !sessionId) return;

    let disposed = false;
    let resizeRafId = 0;

    const currentSettings = settingsRef.current;
    const currentTheme = getThemePreset(currentSettings.themeId);

    const term = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorStyle:
        currentSettings.cursorStyle === 'block' ||
        currentSettings.cursorStyle === 'underline' ||
        currentSettings.cursorStyle === 'bar'
          ? currentSettings.cursorStyle
          : 'bar',
      cursorBlink: currentSettings.cursorBlink,
      fontFamily: currentSettings.fontFamily,
      fontSize: currentSettings.fontSize,
      lineHeight: currentSettings.lineHeight,
      scrollback: currentSettings.scrollback,
      theme: {
        ...currentTheme.xterm,
        background: hexWithAlpha(currentTheme.ui.bgApp, currentSettings.backgroundOpacity),
      },
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(webLinksAddon);

    term.open(el);

    const isJsdom =
      typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('jsdom');
    // Defer WebGL initialization until after mount so StrictMode's synthetic cleanup cancels cleanly.
    const webglRafId = requestAnimationFrame(() => {
      if (disposed || isJsdom) return;
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // Fallback to canvas/DOM renderer
      }
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const sc = settingsRef.current.shortcuts;

      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'C' && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
        return false;
      }

      if (e.ctrlKey && e.shiftKey && e.key.toUpperCase() === 'V') {
        void navigator.clipboard?.readText().then((txt) => {
          if (txt) {
            void shellService.writeSession(sessionId, utf8ToBase64(txt));
          }
        });
        return false;
      }

      const globalShortcuts = [
        sc.newLocalTab,
        sc.newHostModal,
        sc.splitHorizontal,
        sc.splitVertical,
        sc.closePane,
        sc.findInTerminal,
        sc.commandPalette,
        sc.toggleSidebar,
        sc.toggleSftp,
        sc.toggleMonitor,
        sc.openPlugins,
        sc.openSettings,
        sc.nextTab,
        sc.prevTab,
      ];
      if (globalShortcuts.some((s) => matchesShortcut(e, s))) {
        return false;
      }
      return true;
    });

    const onDataDisposable = term.onData((data) => {
      void shellService.writeSession(sessionId, utf8ToBase64(data));
    });

    const onSelectionDisposable = term.onSelectionChange(() => {
      if (settingsRef.current.copyOnSelect && term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection());
      }
    });

    const { unsubscribe, hadEarlyBuffer } = shellService.subscribeSessionOutput(
      sessionId,
      (b64) => {
        try {
          term.write(base64ToBytes(b64));
        } catch {
          // Ignore malformed output chunks
        }
      },
    );

    // Replay buffered history when remounting after drag/float/dock
    if (!hadEarlyBuffer) {
      for (const chunk of shellService.getReplayBytes(sessionId)) {
        term.write(chunk);
      }
    }

    const doFit = () => {
      if (disposed || !el.clientWidth || !el.clientHeight) return;
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          void shellService.resizeSession(sessionId, term.cols, term.rows);
        }
      } catch {
        // Ignore transient zero-size layout errors
      }
    };

    const rafId = requestAnimationFrame(doFit);
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (resizeRafId) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(doFit);
      });
      resizeObserver.observe(el);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(webglRafId);
      cancelAnimationFrame(rafId);
      if (resizeRafId) cancelAnimationFrame(resizeRafId);
      resizeObserver?.disconnect();
      unsubscribe();
      onDataDisposable.dispose();
      onSelectionDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.lineHeight = settings.lineHeight;
    term.options.cursorStyle =
      settings.cursorStyle === 'block' ||
      settings.cursorStyle === 'underline' ||
      settings.cursorStyle === 'bar'
        ? settings.cursorStyle
        : 'bar';
    term.options.cursorBlink = settings.cursorBlink;
    term.options.scrollback = settings.scrollback;
    term.options.theme = {
      ...theme.xterm,
      background: hexWithAlpha(theme.ui.bgApp, settings.backgroundOpacity),
    };
    requestAnimationFrame(() => {
      if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) {
        try {
          fitAddonRef.current?.fit();
        } catch {
          // Ignore
        }
      }
    });
  }, [settings, theme]);

  useEffect(() => {
    if (isActive && sessionId) {
      shellService.setActiveSession(sessionId);
      requestAnimationFrame(() => {
        if (containerRef.current?.clientWidth && containerRef.current?.clientHeight) {
          try {
            fitAddonRef.current?.fit();
          } catch {
            // Ignore
          }
        }
        termRef.current?.focus();
      });
    }
  }, [isActive, isFloating, sessionId]);

  useEffect(() => {
    if (searchSignal > 0 && isActive) {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchSignal, isActive]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleCopy = () => {
    const sel = termRef.current?.getSelection();
    if (sel) void navigator.clipboard?.writeText(sel);
  };

  const handlePaste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '');
    if (text && sessionId) {
      await shellService.writeSession(sessionId, utf8ToBase64(text));
    }
  };

  return (
    <div
      onMouseDown={() => {
        if (sessionId) shellService.setActiveSession(sessionId);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (sessionId) shellService.setActiveSession(sessionId);
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      className="relative flex-1 flex flex-col min-w-0 min-h-0"
      style={{ backgroundColor: 'transparent' }}
    >
      {/* Terminal Quick Action Bar */}
      <div
        className="h-6 px-2 flex items-center justify-between text-[11px] border-b shrink-0 select-none"
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              backgroundColor:
                status === 'connected'
                  ? 'var(--success)'
                  : status === 'error'
                    ? 'var(--danger)'
                    : status === 'connecting'
                      ? 'var(--warning)'
                      : 'var(--text-muted)',
            }}
          />
          <span className="truncate text-[var(--text-muted)]">{viewport.title}</span>
          {statusMsg && (
            <span className="truncate text-[10px] text-[var(--danger)]">{statusMsg}</span>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v);
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
            title="Find (Ctrl+Shift+F)"
            aria-label="Find in terminal"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <Search className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => void termService?.splitActive('horizontal')}
            title="Split Horizontally"
            aria-label="Split pane horizontally"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <Columns2 className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => void termService?.splitActive('vertical')}
            title="Split Vertically"
            aria-label="Split pane vertically"
            className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <Rows2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Floating Search Bar */}
      {searchOpen && (
        <div
          className="absolute top-7 right-3 z-20 flex items-center gap-1 p-1.5 rounded-lg border shadow-lg text-xs"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
        >
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) searchAddonRef.current?.findNext(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) searchAddonRef.current?.findPrevious(searchQuery);
                else searchAddonRef.current?.findNext(searchQuery);
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="Find in output..."
            className="w-40 h-6 px-2 rounded bg-[var(--bg-app)] border border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findPrevious(searchQuery)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => searchAddonRef.current?.findNext(searchQuery)}
            className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Terminal Canvas Host */}
      <div ref={containerRef} className="flex-1 min-h-0 min-w-0 overflow-hidden" />

      {/* Context Menu */}
      {contextMenu && (
        <div
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
          className="fixed z-50 w-44 py-1 rounded-lg border shadow-xl text-xs"
        >
          <button
            type="button"
            onClick={handleCopy}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <Copy className="w-3.5 h-3.5" /> Copy
          </button>
          <button
            type="button"
            onClick={() => void handlePaste()}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <ClipboardPaste className="w-3.5 h-3.5" /> Paste
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={() => void termService?.splitActive('horizontal')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <Columns2 className="w-3.5 h-3.5" /> Split Right
          </button>
          <button
            type="button"
            onClick={() => void termService?.splitActive('vertical')}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <Rows2 className="w-3.5 h-3.5" /> Split Down
          </button>
          {!isFloating && (
            <button
              type="button"
              onClick={() => layoutService.floatViewport(viewport.id)}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
            >
              <PictureInPicture2 className="w-3.5 h-3.5" /> Float Window
            </button>
          )}
          <button
            type="button"
            onClick={() => termRef.current?.clear()}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-[var(--text-primary)] hover:bg-[var(--accent)]/20"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear Buffer
          </button>
        </div>
      )}
    </div>
  );
};
