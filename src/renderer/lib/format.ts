/** Formatting helpers. Every number the UI shows goes through one of these. */

export function bytes(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value / 1024;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit += 1; }
  return `${n.toFixed(n >= 100 ? 0 : digits)} ${units[unit]}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function milliseconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function percent(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function ratio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString();
}

export function time(at: number | null | undefined): string {
  if (!at) return '—';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function dateTime(at: number | null | undefined): string {
  if (!at) return '—';
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

export function relative(at: number | null | undefined): string {
  if (!at) return 'never';
  const delta = Date.now() - at;
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  const days = Math.round(delta / 86_400_000);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

/** A benchmark value of -1 means "could not be measured", never zero. */
export function benchmarkValue(value: number, unit: string): string {
  if (value < 0) return 'unavailable';
  switch (unit) {
    case 'ms': return milliseconds(value);
    case 'bytes': return bytes(value);
    case 'percent': return percent(value, 1);
    case 'ratio': return ratio(value);
    default: return count(value);
  }
}

export function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
