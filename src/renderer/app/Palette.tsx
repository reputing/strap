import { useEffect, useMemo, useRef, useState } from 'react';
import { call, useDebounced } from '@renderer/lib/api';
import { Icon } from '@renderer/components/icons';
import { useToast } from '@renderer/components/ui';
import type { CommandDescriptor, SearchHit } from '@shared/types';

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  page: 'Page', setting: 'Setting', profile: 'Profile', flag: 'FastFlag',
  asset: 'Asset rules', action: 'Optimization', command: 'Command'
};

/**
 * Command palette and global search.
 *
 * One component serves both: opening with no text shows commands grouped by
 * area, typing searches everything. Keeping them together means the user never
 * has to remember which of two boxes they wanted.
 */
export function Palette({
  mode, onClose, onNavigate
}: { mode: 'command' | 'search'; onClose: () => void; onNavigate: (route: string) => void }) {
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term, 130);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [commands, setCommands] = useState<CommandDescriptor[]>([]);
  const [active, setActive] = useState(0);
  const [running, setRunning] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  useEffect(() => {
    void call('commands:list', undefined).then((r) => { if (r.ok) setCommands(r.value); });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!debounced.trim()) { setHits([]); return; }
    void call('search:query', debounced).then((r) => {
      if (!cancelled && r.ok) { setHits(r.value); setActive(0); }
    });
    return () => { cancelled = true; };
  }, [debounced]);

  /** With no search term, the palette lists commands; otherwise, search hits. */
  const rows = useMemo((): { hit: SearchHit; disabled?: string }[] => {
    if (debounced.trim()) {
      const filtered = mode === 'command' ? hits.filter((h) => h.kind === 'command') : hits;
      return filtered.map((hit) => ({
        hit,
        disabled: hit.kind === 'command'
          ? commands.find((c) => c.id === hit.id)?.unavailableReason
          : undefined
      }));
    }
    if (mode !== 'command') return [];
    return commands.map((command) => ({
      hit: {
        kind: 'command', id: command.id, title: command.title,
        subtitle: command.group, route: `command:${command.id}`, score: 0
      },
      disabled: command.unavailableReason
    }));
  }, [debounced, hits, commands, mode]);

  useEffect(() => { setActive((a) => Math.min(a, Math.max(0, rows.length - 1))); }, [rows.length]);

  const activate = async (row: { hit: SearchHit; disabled?: string }) => {
    if (row.disabled) return;
    if (row.hit.route.startsWith('command:')) {
      const id = row.hit.route.slice('command:'.length);
      setRunning(true);
      const result = await call('commands:run', { id });
      setRunning(false);
      if (!result.ok) {
        toast({ kind: 'error', title: 'That command did not run', message: result.error.message });
        return;
      }
    } else {
      onNavigate(row.hit.route);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    if (e.key === 'End') { e.preventDefault(); setActive(rows.length - 1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) void activate(row);
    }
  };

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup = '';

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={mode === 'command' ? 'Command palette' : 'Search'}>
        <input
          autoFocus
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={mode === 'command' ? 'Run a command…' : 'Search settings, profiles, flags, assets…'}
          aria-label="Search"
          spellCheck={false}
        />

        <div className="results" ref={listRef}>
          {rows.length === 0 ? (
            <div className="state" style={{ padding: 'var(--s7)' }}>
              <p className="small">{term.trim() ? `Nothing matches “${term.trim()}”.` : 'Start typing to search.'}</p>
            </div>
          ) : rows.map((row, index) => {
            const group = debounced.trim() ? KIND_LABEL[row.hit.kind] : row.hit.subtitle;
            const showGroup = group !== lastGroup;
            lastGroup = group;
            return (
              <div key={`${row.hit.kind}-${row.hit.id}`}>
                {showGroup ? <div className="group-label">{group}</div> : null}
                <button
                  className="hit"
                  data-index={index}
                  data-active={index === active}
                  disabled={Boolean(row.disabled) || running}
                  title={row.disabled}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void activate(row)}
                >
                  <span className="title">{row.hit.title}</span>
                  <span className="sub">{row.disabled ?? (debounced.trim() ? row.hit.subtitle : '')}</span>
                </button>
              </div>
            );
          })}
        </div>

        <footer>
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
          {running ? <span className="flex"><span className="spinner" /> working</span> : null}
          <span style={{ marginLeft: 'auto' }}>
            <Icon.logo size={11} />
          </span>
        </footer>
      </div>
    </div>
  );
}
