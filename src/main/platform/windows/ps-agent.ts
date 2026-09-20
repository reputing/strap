import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import { AGENT_SCRIPT } from './agent-script';

interface Pending {
  resolve: (r: Result<unknown>) => void;
  timer: NodeJS.Timeout;
}

/**
 * A single long-lived PowerShell process that the Windows adapter talks to over
 * newline-delimited JSON. Restarts itself if it dies, with backoff, and fails
 * requests cleanly rather than hanging when it cannot come back.
 */
export class PowerShellAgent extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private scriptPath: string | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private starting: Promise<Result<void>> | null = null;
  private restarts = 0;
  private disposed = false;
  /** Re-issued after a restart so watches survive the agent dying. */
  private watchedNames: string[] | null = null;

  constructor(private readonly log: ScopedLogger) {
    super();
    this.setMaxListeners(30);
  }

  async start(): Promise<Result<void>> {
    if (this.child) return Ok(undefined);
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async doStart(): Promise<Result<void>> {
    try {
      const dir = join(tmpdir(), 'blossom-strap');
      await mkdir(dir, { recursive: true });
      this.scriptPath = join(dir, `agent-${process.pid}.ps1`);
      await writeFile(this.scriptPath, AGENT_SCRIPT, 'utf8');

      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      this.child = child;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        const text = chunk.trim();
        if (text) this.log.debug('Agent stderr', { text: text.slice(0, 400) });
      });
      child.on('exit', (code) => this.onExit(code));
      child.on('error', (e) => {
        this.log.error('Could not start the Windows helper', { reason: e.message });
        this.child = null;
      });

      const ready = await this.waitForReady(child, 15_000);
      if (!ready) {
        child.kill();
        this.child = null;
        return Err('io-failure', 'The Windows helper did not start.', {
          remediation: 'Check that PowerShell is available and not blocked by policy. Blossom falls back to reduced functionality without it.'
        });
      }
      this.restarts = 0;
      if (this.watchedNames) void this.request('watch', { names: this.watchedNames });
      return Ok(undefined);
    } catch (e) {
      this.child = null;
      return Err('io-failure', 'The Windows helper could not be launched.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  private waitForReady(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const onReady = () => { cleanup(); resolve(true); };
      const onExit = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
        child.off('exit', onExit);
      };
      this.once('ready', onReady);
      child.once('exit', onExit);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // Non-JSON noise from a cmdlet; ignore it.
      }
      const type = msg['type'];
      if (type === 'ready') {
        this.emit('ready');
      } else if (type === 'event') {
        this.emit('agent-event', msg);
      } else if (type === 'reply') {
        const id = Number(msg['id']);
        const p = this.pending.get(id);
        if (!p) continue;
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(
          msg['ok']
            ? Ok(msg['data'])
            : Err('io-failure', String(msg['error'] ?? 'The Windows helper reported an error.'))
        );
      }
    }
    // A runaway producer must not grow this buffer without bound.
    if (this.buffer.length > 1_000_000) this.buffer = '';
  }

  private onExit(code: number | null): void {
    this.child = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(Err('io-failure', 'The Windows helper stopped before answering.'));
      this.pending.delete(id);
    }
    if (this.disposed) return;
    this.restarts += 1;
    if (this.restarts > 5) {
      this.log.error('Windows helper keeps stopping; giving up', { code });
      this.emit('unavailable');
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** this.restarts);
    this.log.warn('Windows helper stopped; restarting', { code, delayMs: delay, attempt: this.restarts });
    setTimeout(() => { void this.start(); }, delay).unref?.();
  }

  async request<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Result<T>> {
    if (!this.child) {
      const started = await this.start();
      if (!started.ok) return started;
    }
    const child = this.child;
    if (!child) return Err('io-failure', 'The Windows helper is not running.');

    if (op === 'watch' && Array.isArray(params['names'])) {
      this.watchedNames = params['names'] as string[];
    }

    const id = this.nextId++;
    return new Promise<Result<T>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(Err('timeout', `The Windows helper did not answer in time (${op}).`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (r: Result<unknown>) => void, timer });
      try {
        child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(Err('io-failure', e instanceof Error ? e.message : 'Could not reach the Windows helper.'));
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch { /* already closed */ }
      child.kill();
    }
    if (this.scriptPath) await rm(this.scriptPath, { force: true }).catch(() => undefined);
  }
}
