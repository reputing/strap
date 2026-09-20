import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState, type ReactNode
} from 'react';
import type { BlossomError } from '@shared/result';
import { Icon } from './icons';

/* ── buttons and controls ─────────────────────────────────────────────── */

export function Button({
  children, onClick, variant = 'default', size, disabled, title, type = 'button', pending, icon
}: {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'lg' | 'icon';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  pending?: boolean;
  icon?: ReactNode;
}) {
  const className = ['btn', variant !== 'default' ? variant : '', size ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={className} onClick={onClick} disabled={disabled || pending} title={title}>
      {pending ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

export function Toggle({
  checked, onChange, disabled, label
}: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      className="toggle"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Segmented<T extends string>({
  value, options, onChange, disabled
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({
  value, options, onChange, disabled, ariaLabel
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <select
      className="select"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Row({
  name, desc, children, badge
}: { name: ReactNode; desc?: ReactNode; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className="row">
      <div className="label">
        <div className="name">{name}{badge}</div>
        {desc ? <div className="desc">{desc}</div> : null}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

export function Section({
  title, hint, actions, children
}: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        {hint ? <span className="hint">{hint}</span> : null}
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Panel({
  head, children, flush
}: { head?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <div className={flush ? 'panel flush' : 'panel'}>
      {head ? <div className="panel-head">{head}</div> : null}
      <div className="panel-body">{children}</div>
    </div>
  );
}

export function Badge({
  children, tone = 'default'
}: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' }) {
  return <span className={tone === 'default' ? 'badge' : `badge ${tone}`}>{children}</span>;
}

export function Dot({ tone }: { tone: 'idle' | 'ok' | 'warn' | 'danger' | 'live' }) {
  return <span className={tone === 'idle' ? 'dot' : `dot ${tone}`} />;
}

export function Meter({ value, tone }: { value: number; tone?: 'ok' | 'warn' | 'danger' }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div className={tone ? `meter ${tone}` : 'meter'}>
      <span style={{ width: `${clamped * 100}%` }} />
    </div>
  );
}

/* ── states ───────────────────────────────────────────────────────────── */

export function Empty({
  icon, title, children, action
}: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      {icon ? <span className="glyph">{icon}</span> : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state">
      <span className="spinner" />
      <p>{label}…</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: BlossomError; onRetry?: () => void }) {
  return (
    <div className="state">
      <span className="glyph"><Icon.warning size={22} /></span>
      <h3>{error.message}</h3>
      {error.remediation ? <p>{error.remediation}</p> : null}
      {onRetry ? <Button onClick={onRetry} icon={<Icon.refresh size={13} />}>Try again</Button> : null}
    </div>
  );
}

export function Notice({
  tone = 'default', title, children, action
}: { tone?: 'default' | 'warn' | 'danger' | 'info'; title?: string; children: ReactNode; action?: ReactNode }) {
  const glyph = tone === 'warn' || tone === 'danger' ? <Icon.warning size={14} /> : <Icon.info size={14} />;
  return (
    <div className={tone === 'default' ? 'notice' : `notice ${tone}`}>
      <span className="glyph">{glyph}</span>
      <div style={{ flex: 1 }}>
        {title ? <strong>{title}</strong> : null}
        {children}
      </div>
      {action}
    </div>
  );
}

/** Renders one of loading / error / empty / content, so pages never repeat it. */
export function Async<T>({
  query, empty, children
}: {
  query: { data: T | null; error: BlossomError | null; loading: boolean; refetch: () => void };
  empty?: (data: T) => ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.error) return <ErrorState error={query.error} onRetry={query.refetch} />;
  if (query.data === null) return query.loading ? <Loading /> : <Empty title="Nothing to show" />;
  const emptyNode = empty?.(query.data);
  if (emptyNode) return <>{emptyNode}</>;
  return <>{children(query.data)}</>;
}

/* ── modal ────────────────────────────────────────────────────────────── */

export function Modal({
  title, description, children, footer, onClose, width
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key !== 'Tab' || !ref.current) return;
      // Keep focus inside the dialog; a modal you can tab out of is not modal.
      const focusable = ref.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        style={width ? { width } : undefined}
      >
        <header>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

/** A confirm dialog that states what will happen rather than asking "are you sure". */
export function Confirm({
  title, description, confirmLabel, danger, onConfirm, onClose, pending
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  pending?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} pending={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="muted small">{description}</div>
    </Modal>
  );
}

/* ── tooltip ──────────────────────────────────────────────────────────── */

export function Tip({ text, children }: { text: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);

  const show = () => {
    timer.current = window.setTimeout(() => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect) setPosition({ x: rect.left, y: rect.bottom + 6 });
    }, 400);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setPosition(null);
  };
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return (
    <>
      <span ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {position ? (
        <div className="tooltip" style={{ left: Math.min(position.x, window.innerWidth - 300), top: position.y }} role="tooltip">
          {text}
        </div>
      ) : null}
    </>
  );
}

/* ── context menu ─────────────────────────────────────────────────────── */

export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  icon?: ReactNode;
}

export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const open = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const node = menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open, node };
}

function ContextMenu({
  x, y, items, onClose
}: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    // Keep the menu on screen when opened near an edge.
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({
      x: Math.min(x, window.innerWidth - rect.width - 8),
      y: Math.min(y, window.innerHeight - rect.height - 8)
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
      {items.map((item, i) => item.separator
        ? <hr key={`sep-${i}`} />
        : (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => { item.onSelect?.(); onClose(); }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
    </div>
  );
}

/* ── toasts ───────────────────────────────────────────────────────────── */

export interface ToastMessage {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
}

const ToastContext = createContext<(t: Omit<ToastMessage, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const next = useRef(1);

  const push = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const id = next.current++;
    setToasts((current) => [...current.slice(-3), { ...toast, id }]);
    // Errors stay until dismissed; everything else clears itself.
    if (toast.kind !== 'error') {
      window.setTimeout(() => setToasts((c) => c.filter((t) => t.id !== id)), 5200);
    }
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`} role="status">
            <div style={{ flex: 1 }}>
              <strong>{toast.title}</strong>
              {toast.message ? <p>{toast.message}</p> : null}
            </div>
            <button
              className="btn ghost icon close"
              aria-label="Dismiss"
              onClick={() => setToasts((c) => c.filter((t) => t.id !== toast.id))}
            >
              <Icon.x size={12} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ── labelled field ───────────────────────────────────────────────────── */

export function Field({
  label, hint, error, children
}: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="col" style={{ gap: 'var(--s2)' }}>
      <label htmlFor={id} className="micro dim" style={{ fontWeight: 500, letterSpacing: '0.03em', textTransform: 'uppercase' }}>
        {label}
      </label>
      {children(id)}
      {error ? <span className="micro" style={{ color: 'var(--danger)' }}>{error}</span> : null}
      {!error && hint ? <span className="micro dim">{hint}</span> : null}
    </div>
  );
}
