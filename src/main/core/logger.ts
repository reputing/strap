import { createWriteStream, WriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { LogLevel, LogRecord } from '@shared/types';
import { ensureDir, redact } from './redact';

const ORDER: Record<LogLevel, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, critical: 60
};

const LABEL: Record<LogLevel, string> = {
  trace: 'TRACE', debug: 'DEBUG', info: 'INFO ',
  warn: 'WARN ', error: 'ERROR', critical: 'CRIT '
};

export interface LoggerOptions {
  directory: string;
  level: LogLevel;
  /** Rotate once the active file passes this many bytes. */
  maxBytes?: number;
  /** Keep this many rotated files. */
  maxFiles?: number;
  /** Also mirror to stdout. Off in packaged builds. */
  console?: boolean;
}

/**
 * Structured logger with a human-readable on-disk format.
 *
 *   [12:43:02] INFO  roblox    Roblox detected  version=0.678.1
 *
 * Records are also kept in a small ring buffer so Diagnostics can show recent
 * activity without reading files, and pushed as events for the live log view.
 */
export class Logger extends EventEmitter {
  private stream: WriteStream | null = null;
  private bytes = 0;
  private readonly ring: LogRecord[] = [];
  private readonly ringSize = 500;
  private level: LogLevel;
  private readonly opts: Required<LoggerOptions>;
  private ready: Promise<void>;

  constructor(options: LoggerOptions) {
    super();
    this.setMaxListeners(50);
    this.opts = {
      maxBytes: 2 * 1024 * 1024,
      maxFiles: 5,
      console: false,
      ...options
    };
    this.level = options.level;
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    try {
      await ensureDir(this.opts.directory);
      await this.prune();
      const name = `blossom-${new Date().toISOString().slice(0, 10)}.log`;
      const path = join(this.opts.directory, name);
      try {
        this.bytes = (await fs.stat(path)).size;
      } catch {
        this.bytes = 0;
      }
      this.stream = createWriteStream(path, { flags: 'a' });
      this.stream.on('error', () => { this.stream = null; });
    } catch {
      // Logging must never be the reason the app fails to start.
      this.stream = null;
    }
  }

  private async prune(): Promise<void> {
    try {
      const files = (await fs.readdir(this.opts.directory))
        .filter((f) => f.startsWith('blossom-') && f.endsWith('.log'))
        .sort()
        .reverse();
      for (const stale of files.slice(this.opts.maxFiles)) {
        await fs.rm(join(this.opts.directory, stale), { force: true });
      }
    } catch { /* nothing to prune */ }
  }

  private async rotate(): Promise<void> {
    if (!this.stream) return;
    const old = this.stream;
    this.stream = null;
    await new Promise<void>((r) => old.end(r));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const from = join(this.opts.directory, `blossom-${new Date().toISOString().slice(0, 10)}.log`);
    await fs.rename(from, `${from}.${stamp}`).catch(() => undefined);
    this.bytes = 0;
    this.ready = this.open();
    await this.ready;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  /** Recent records, newest last. */
  recent(limit = 200, minLevel?: LogLevel): LogRecord[] {
    const floor = minLevel ? ORDER[minLevel] : 0;
    return this.ring.filter((r) => ORDER[r.level] >= floor).slice(-limit);
  }

  /** A scoped logger; the scope shows up in every line it writes. */
  scope(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope);
  }

  write(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;

    const record: LogRecord = {
      at: Date.now(),
      level,
      scope,
      message: redact(message),
      ...(data ? { data: redactData(data) } : {})
    };

    this.ring.push(record);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emit('record', record);

    const line = formatRecord(record);
    if (this.opts.console) process.stdout.write(line + '\n');

    if (this.stream) {
      this.stream.write(line + '\n');
      this.bytes += line.length + 1;
      if (this.bytes > this.opts.maxBytes) void this.rotate();
    }
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((r) => s.end(r));
  }
}

export class ScopedLogger {
  constructor(private readonly logger: Logger, private readonly scopeName: string) {}

  trace(m: string, d?: Record<string, unknown>) { this.logger.write('trace', this.scopeName, m, d); }
  debug(m: string, d?: Record<string, unknown>) { this.logger.write('debug', this.scopeName, m, d); }
  info(m: string, d?: Record<string, unknown>) { this.logger.write('info', this.scopeName, m, d); }
  warn(m: string, d?: Record<string, unknown>) { this.logger.write('warn', this.scopeName, m, d); }
  error(m: string, d?: Record<string, unknown>) { this.logger.write('error', this.scopeName, m, d); }
  critical(m: string, d?: Record<string, unknown>) { this.logger.write('critical', this.scopeName, m, d); }

  child(name: string): ScopedLogger {
    return new ScopedLogger(this.logger, `${this.scopeName}.${name}`);
  }
}

export function formatRecord(r: LogRecord): string {
  const t = new Date(r.at);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const scope = r.scope.padEnd(12).slice(0, 12);
  let line = `[${hh}:${mm}:${ss}] ${LABEL[r.level]} ${scope} ${r.message}`;
  if (r.data && Object.keys(r.data).length) {
    const pairs = Object.entries(r.data)
      .map(([k, v]) => `${k}=${formatValue(v)}`)
      .join(' ');
    line += `  ${pairs}`;
  }
  return line;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const json = JSON.stringify(v);
    return json.length > 200 ? json.slice(0, 197) + '…' : json;
  } catch {
    return '[unserialisable]';
  }
}

function redactData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' ? redact(v) : v;
  }
  return out;
}
