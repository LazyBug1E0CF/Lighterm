import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  icon?: React.ReactNode;
}

export interface CustomSelectProps {
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
  ariaLabel,
  value,
  options,
  onChange,
  placeholder = 'Select an option...',
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedIndex = options.findIndex((opt) => opt.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    setHighlightedIdx(selectedIndex >= 0 ? selectedIndex : 0);

    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect && typeof window !== 'undefined') {
      const spaceBelow = window.innerHeight - rect.bottom;
      setOpenUpward(spaceBelow < 220 && rect.top > spaceBelow);
    } else {
      setOpenUpward(false);
    }

    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onBlur = () => setOpen(false);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, selectedIndex]);

  const selectAt = (idx: number) => {
    const opt = options[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
      }
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      setHighlightedIdx(Math.max(0, options.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      selectAt(highlightedIdx);
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        className={`w-full h-9 px-3 rounded-lg border flex items-center justify-between gap-2 text-left text-xs transition-all outline-none cursor-pointer ${
          open
            ? 'bg-[var(--bg-app)] border-[var(--accent)] ring-1 ring-[var(--accent)]/30 text-[var(--text-primary)]'
            : 'bg-[var(--bg-app)]/80 border-[var(--border-subtle)] hover:border-[var(--accent)]/60 hover:bg-[var(--bg-app)] text-[var(--text-primary)]'
        }`}
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          {selectedOption?.icon && <span className="shrink-0 flex items-center">{selectedOption.icon}</span>}
          <span className="truncate font-medium">
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          {selectedOption?.badge && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[var(--accent)]/15 text-[var(--accent)] shrink-0">
              {selectedOption.badge}
            </span>
          )}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180 text-[var(--accent)]' : ''
          }`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={`${ariaLabel} options`}
          onKeyDown={handleKeyDown}
          style={{
            backgroundColor: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
          className={`lighterm-pop-enter absolute left-0 right-0 z-50 rounded-xl border shadow-2xl p-1.5 max-h-64 overflow-y-auto lighterm-scroll space-y-0.5 ${
            openUpward ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightedIdx;
            return (
              <button
                key={opt.value || '__empty__'}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlightedIdx(idx)}
                onClick={() => selectAt(idx)}
                className={`w-full px-2.5 py-2 rounded-lg flex items-center justify-between gap-2.5 text-left transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-[var(--accent)]/18 text-[var(--text-primary)]'
                    : isHighlighted
                      ? 'bg-[var(--bg-surface)] text-[var(--text-primary)]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-surface)]/80'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {opt.icon && <span className="shrink-0 flex items-center">{opt.icon}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{opt.label}</span>
                      {opt.badge && (
                        <span className="px-1.5 py-0 rounded text-[9px] font-medium bg-[var(--bg-app)] text-[var(--text-muted)] shrink-0">
                          {opt.badge}
                        </span>
                      )}
                    </div>
                    {opt.description && (
                      <div className="text-[11px] font-mono text-[var(--text-muted)] truncate mt-0.5">
                        {opt.description}
                      </div>
                    )}
                  </div>
                </div>
                <Check
                  className={`w-3.5 h-3.5 shrink-0 text-[var(--accent)] transition-opacity ${
                    isSelected ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
