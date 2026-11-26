import React from 'react';
import { isWebRuntime } from '../../core/ipc';
import { useWindowStore, windowControls } from '../../core/windowControls';

const WinMinimizeGlyph: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

const WinMaximizeGlyph: React.FC<{ maximized: boolean }> = ({ maximized }) =>
  maximized ? (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.2 2.6V1.2H8.8V6.8H7.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <rect
        x="1.2"
        y="3.2"
        width="5.6"
        height="5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  ) : (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="7"
        height="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
      />
    </svg>
  );

const WinCloseGlyph: React.FC = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path
      d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
      stroke="currentColor"
      strokeWidth="1.15"
      strokeLinecap="round"
    />
  </svg>
);

export const WindowControls: React.FC = () => {
  const platform = useWindowStore((s) => s.platform);
  const maximized = useWindowStore((s) => s.maximized);
  const focused = useWindowStore((s) => s.focused);

  if (isWebRuntime()) return null;

  const maximizeLabel = maximized ? 'Restore Window' : 'Maximize Window';
  const maximizeTitle = maximized ? 'Restore' : 'Maximize';

  if (platform === 'macos') {
    return (
      <div
        role="group"
        aria-label="Window Controls"
        data-no-window-drag="true"
        className="group/mac flex items-center gap-2 pr-2.5 mr-0.5 border-r border-[var(--border-subtle)] shrink-0"
      >
        <button
          type="button"
          aria-label="Close Window"
          title="Close"
          onClick={() => windowControls.close()}
          className={`w-3 h-3 rounded-full flex items-center justify-center border transition-colors ${
            focused
              ? 'bg-[#ff5f57] border-[#e0443e]/80 text-[#4d0000]'
              : 'bg-white/15 border-white/10 text-[#4d0000] group-hover/mac:bg-[#ff5f57] group-hover/mac:border-[#e0443e]/80'
          }`}
        >
          <svg
            width="6"
            height="6"
            viewBox="0 0 8 8"
            aria-hidden="true"
            className="opacity-0 group-hover/mac:opacity-100 transition-opacity"
          >
            <path
              d="M1.5 1.5L6.5 6.5M6.5 1.5L1.5 6.5"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          aria-label="Minimize Window"
          title="Minimize"
          onClick={() => windowControls.minimize()}
          className={`w-3 h-3 rounded-full flex items-center justify-center border transition-colors ${
            focused
              ? 'bg-[#febc2e] border-[#d89e24]/80 text-[#5c3d00]'
              : 'bg-white/15 border-white/10 text-[#5c3d00] group-hover/mac:bg-[#febc2e] group-hover/mac:border-[#d89e24]/80'
          }`}
        >
          <svg
            width="6"
            height="6"
            viewBox="0 0 8 8"
            aria-hidden="true"
            className="opacity-0 group-hover/mac:opacity-100 transition-opacity"
          >
            <line
              x1="1.2"
              y1="4"
              x2="6.8"
              y2="4"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          aria-label={maximizeLabel}
          title={maximizeTitle}
          onClick={() => void windowControls.toggleMaximize()}
          className={`w-3 h-3 rounded-full flex items-center justify-center border transition-colors ${
            focused
              ? 'bg-[#28c840] border-[#1aab29]/80 text-[#004d0f]'
              : 'bg-white/15 border-white/10 text-[#004d0f] group-hover/mac:bg-[#28c840] group-hover/mac:border-[#1aab29]/80'
          }`}
        >
          <svg
            width="6"
            height="6"
            viewBox="0 0 8 8"
            aria-hidden="true"
            className="opacity-0 group-hover/mac:opacity-100 transition-opacity"
          >
            {maximized ? (
              <path
                d="M1.4 3.6H4.4V6.6M6.6 4.4H3.6V1.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path d="M1.5 1.5H5.2L1.5 5.2ZM6.5 6.5H2.8L6.5 2.8Z" fill="currentColor" />
            )}
          </svg>
        </button>
      </div>
    );
  }

  if (platform === 'linux') {
    return (
      <div
        role="group"
        aria-label="Window Controls"
        data-no-window-drag="true"
        className={`flex items-center gap-1.5 pl-2 border-l border-[var(--border-subtle)] shrink-0 ${
          focused ? 'opacity-100' : 'opacity-65'
        }`}
      >
        <button
          type="button"
          aria-label="Minimize Window"
          title="Minimize"
          onClick={() => windowControls.minimize()}
          className="w-6 h-6 rounded-full flex items-center justify-center bg-[var(--bg-elevated)]/80 hover:bg-white/15 text-[var(--text-primary)] transition-colors"
        >
          <WinMinimizeGlyph />
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          title={maximizeTitle}
          onClick={() => void windowControls.toggleMaximize()}
          className="w-6 h-6 rounded-full flex items-center justify-center bg-[var(--bg-elevated)]/80 hover:bg-white/15 text-[var(--text-primary)] transition-colors"
        >
          <WinMaximizeGlyph maximized={maximized} />
        </button>
        <button
          type="button"
          aria-label="Close Window"
          title="Close"
          onClick={() => windowControls.close()}
          className="w-6 h-6 rounded-full flex items-center justify-center bg-[var(--bg-elevated)]/80 hover:bg-[var(--danger)] hover:text-white text-[var(--text-primary)] transition-colors"
        >
          <WinCloseGlyph />
        </button>
      </div>
    );
  }

  // Default: Windows 11 full-height flush caption buttons at the top-right end
  return (
    <div
      role="group"
      aria-label="Window Controls"
      data-no-window-drag="true"
      className={`flex items-stretch h-full shrink-0 ml-1 border-l border-[var(--border-subtle)]/70 ${
        focused ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
      }`}
    >
      <button
        type="button"
        aria-label="Minimize Window"
        title="Minimize"
        onClick={() => windowControls.minimize()}
        className="w-11 h-full flex items-center justify-center hover:bg-white/10 active:bg-white/15 transition-colors"
      >
        <WinMinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximizeLabel}
        title={maximizeTitle}
        onClick={() => void windowControls.toggleMaximize()}
        className="w-11 h-full flex items-center justify-center hover:bg-white/10 active:bg-white/15 transition-colors"
      >
        <WinMaximizeGlyph maximized={maximized} />
      </button>
      <button
        type="button"
        aria-label="Close Window"
        title="Close"
        onClick={() => windowControls.close()}
        className="w-11 h-full flex items-center justify-center hover:bg-[#e81123] hover:text-white active:bg-[#f1707a] active:text-black transition-colors"
      >
        <WinCloseGlyph />
      </button>
    </div>
  );
};
