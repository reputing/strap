import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  width: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  render: (row: T) => ReactNode;
}

/**
 * A windowed table.
 *
 * The cache can hold tens of thousands of assets; rendering them all is how a
 * browser like this becomes unusable. Only the rows in view plus a small
 * overscan are mounted, and the scroll height comes from the total count so the
 * scrollbar still behaves correctly.
 */
export function VirtualTable<T>({
  rows, columns, rowHeight = 30, height, getKey, onRowClick, onRowContextMenu,
  selectedKey, sort, onSort, onReachEnd
}: {
  rows: T[];
  columns: Column<T>[];
  rowHeight?: number;
  height: number;
  getKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  onRowContextMenu?: (row: T, e: React.MouseEvent) => void;
  selectedKey?: string | null;
  sort?: { key: string; direction: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  /** Called when the viewport nears the end, for paged loading. */
  onReachEnd?: () => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const endFired = useRef(false);

  const overscan = 6;
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rows.length, start + visibleCount);
  const slice = useMemo(() => rows.slice(start, end), [rows, start, end]);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const element = e.currentTarget;
    setScrollTop(element.scrollTop);

    if (!onReachEnd) return;
    const remaining = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (remaining < rowHeight * 10) {
      if (!endFired.current) { endFired.current = true; onReachEnd(); }
    } else {
      endFired.current = false;
    }
  }, [onReachEnd, rowHeight]);

  // A shorter list after a filter change must not leave the view scrolled past it.
  useEffect(() => {
    if (viewportRef.current && scrollTop > rows.length * rowHeight) {
      viewportRef.current.scrollTop = 0;
      setScrollTop(0);
    }
  }, [rows.length, rowHeight, scrollTop]);

  const template = columns.map((c) => c.width).join(' ');

  return (
    <div className="panel flush">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: template,
          borderBottom: '1px solid var(--line)',
          background: 'var(--surface)'
        }}
      >
        {columns.map((column) => (
          <button
            key={column.key}
            className={column.sortable ? 'table-head sortable' : 'table-head'}
            onClick={() => column.sortable && onSort?.(column.key)}
            disabled={!column.sortable}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              padding: 'var(--s3) var(--s4)',
              fontSize: 'var(--t-micro)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: sort?.key === column.key ? 'var(--text)' : 'var(--text-3)',
              textAlign: column.align ?? 'left',
              cursor: column.sortable ? 'pointer' : 'default',
              whiteSpace: 'nowrap'
            }}
          >
            {column.header}
            {sort?.key === column.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
          </button>
        ))}
      </div>

      <div className="vlist" style={{ height }} onScroll={onScroll} ref={viewportRef}>
        <div className="vlist-inner" style={{ height: rows.length * rowHeight }}>
          {slice.map((row, index) => {
            const key = getKey(row);
            const selected = selectedKey === key;
            return (
              <div
                key={key}
                className="vlist-row"
                style={{
                  top: (start + index) * rowHeight,
                  height: rowHeight,
                  display: 'grid',
                  gridTemplateColumns: template,
                  borderBottom: '1px solid var(--line)',
                  background: selected ? 'var(--accent-soft)' : undefined,
                  cursor: onRowClick ? 'pointer' : undefined
                }}
                onClick={() => onRowClick?.(row)}
                onContextMenu={(e) => onRowContextMenu?.(row, e)}
                aria-selected={selected}
              >
                {columns.map((column) => (
                  <div
                    key={column.key}
                    style={{
                      padding: '0 var(--s4)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: column.align === 'right' ? 'flex-end' : 'flex-start',
                      overflow: 'hidden',
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      fontSize: 'var(--t-small)'
                    }}
                  >
                    {column.render(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
