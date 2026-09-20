import { EventEmitter } from 'node:events';
import type { ProcessSample, RobloxKind, RobloxProcess } from '@shared/types';
import type { PlatformAdapter, ProcessCounters } from '@main/platform';
import type { ScopedLogger } from '@main/core/logger';
import { PLAYER_EXECUTABLE, STUDIO_EXECUTABLE, kindForExecutable } from './discovery';

const WATCHED = [PLAYER_EXECUTABLE, STUDIO_EXECUTABLE];

/**
 * Tracks live Roblox processes.
 *
 * Lifetime is event-driven — the platform adapter subscribes to OS process
 * notifications, so this class runs no timer of its own just to notice that
 * Roblox started. The only timer that ever runs is the counter sampler, and it
 * runs only while something is actually displaying the numbers.
 */
export class ProcessMonitor extends EventEmitter {
  private readonly processes = new Map<number, RobloxProcess>();
  private readonly ownedPids = new Set<number>();
  private previous = new Map<number, ProcessCounters>();
  private previousAt = new Map<number, number>();
  private unwatch: (() => void) | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private samplingRefs = 0;
  private cores = 1;
  private sampleInFlight = false;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly log: ScopedLogger
  ) {
    super();
    this.setMaxListeners(30);
  }

  async start(): Promise<void> {
    const hardware = await this.platform.queryHardware();
    if (hardware.ok) this.cores = Math.max(1, hardware.value.cpu.threads || 1);

    const existing = await this.platform.listProcesses(WATCHED);
    if (existing.ok) {
      for (const p of existing.value) this.add(p.pid, p.name, p.executable, p.startedAt);
      if (existing.value.length) {
        this.log.info('Roblox is already running', { count: existing.value.length });
      }
    }

    const watch = await this.platform.watchProcesses(WATCHED, (e) => {
      if (e.kind === 'started') {
        this.add(e.process.pid, e.process.name, e.process.executable, e.process.startedAt);
      } else {
        this.remove(e.pid);
      }
    });

    if (watch.ok) {
      this.unwatch = watch.value;
      this.log.debug('Subscribed to Roblox process events');
    } else {
      this.log.warn('Process events are unavailable; Roblox state will only refresh on demand', {
        reason: watch.error.message
      });
    }
  }

  private add(pid: number, name: string, executable: string | null, startedAt: number): void {
    if (this.processes.has(pid)) return;
    const kind: RobloxKind = kindForExecutable(name) ?? kindForExecutable(executable ?? '') ?? 'player';
    const entry: RobloxProcess = {
      pid,
      kind,
      startedAt,
      executable,
      ownedByBlossom: this.ownedPids.has(pid)
    };
    this.processes.set(pid, entry);
    this.log.info('Roblox started', { pid, kind });
    this.emit('started', entry);
    this.emit('changed', this.list());
  }

  private remove(pid: number): void {
    const entry = this.processes.get(pid);
    if (!entry) return;
    this.processes.delete(pid);
    this.previous.delete(pid);
    this.previousAt.delete(pid);
    this.ownedPids.delete(pid);
    this.log.info('Roblox closed', { pid, uptimeMs: Date.now() - entry.startedAt });
    this.emit('stopped', entry);
    this.emit('changed', this.list());
    if (!this.processes.size) this.stopSampling();
  }

  /** Marks a pid as launched by Blossom, so the UI can distinguish it. */
  claim(pid: number): void {
    this.ownedPids.add(pid);
    const existing = this.processes.get(pid);
    if (existing) {
      existing.ownedByBlossom = true;
      this.emit('changed', this.list());
    }
  }

  list(): RobloxProcess[] {
    return [...this.processes.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  primary(kind: RobloxKind = 'player'): RobloxProcess | null {
    return this.list().find((p) => p.kind === kind) ?? null;
  }

  isRunning(kind?: RobloxKind): boolean {
    return kind ? this.list().some((p) => p.kind === kind) : this.processes.size > 0;
  }

  /**
   * Starts counter sampling and returns a release function. Sampling is
   * reference-counted: it stops as soon as nothing is looking at the numbers,
   * which is what keeps Blossom's idle cost near zero.
   */
  acquireSampling(intervalMs = 1000): () => void {
    this.samplingRefs += 1;
    if (!this.sampleTimer && this.processes.size) {
      this.sampleTimer = setInterval(() => { void this.sampleAll(); }, intervalMs);
      this.sampleTimer.unref?.();
      void this.sampleAll();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.samplingRefs = Math.max(0, this.samplingRefs - 1);
      if (!this.samplingRefs) this.stopSampling();
    };
  }

  private stopSampling(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
  }

  private async sampleAll(): Promise<void> {
    // Never let a slow OS query stack up behind the interval.
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      for (const pid of [...this.processes.keys()]) {
        const r = await this.platform.sampleProcess(pid);
        if (!r.ok) {
          // A process that vanished between the event and the sample is normal.
          if (r.error.code === 'not-found') this.remove(pid);
          continue;
        }
        const current = r.value;
        const now = Date.now();
        const prev = this.previous.get(pid);
        this.previous.set(pid, current);
        const prevAt = this.previousAt.get(pid);
        this.previousAt.set(pid, now);

        // CPU percent is a delta measurement, so the first sample after a
        // process appears has nothing to compare against and reports null
        // rather than a made-up zero.
        let cpuPercent: number | null = null;
        if (prev && prevAt !== undefined) {
          const elapsedMs = now - prevAt;
          if (elapsedMs > 0) {
            const cpuDeltaMs = Math.max(0, current.cpuTimeMs - prev.cpuTimeMs);
            cpuPercent = clampPercent((cpuDeltaMs / (elapsedMs * this.cores)) * 100);
          }
        }

        this.emit('sample', {
          pid,
          at: now,
          cpuPercent,
          memoryBytes: current.memoryBytes || null,
          uptimeMs: Math.max(0, now - current.startedAt)
        } satisfies ProcessSample);
      }
    } finally {
      this.sampleInFlight = false;
    }
  }

  /** Re-reads the process list from the OS. Used when events are unavailable. */
  async refresh(): Promise<void> {
    const r = await this.platform.listProcesses(WATCHED);
    if (!r.ok) return;
    const seen = new Set<number>();
    for (const p of r.value) {
      seen.add(p.pid);
      this.add(p.pid, p.name, p.executable, p.startedAt);
    }
    for (const pid of [...this.processes.keys()]) {
      if (!seen.has(pid)) this.remove(pid);
    }
  }

  async close(kind?: RobloxKind): Promise<number> {
    let closed = 0;
    for (const p of this.list()) {
      if (kind && p.kind !== kind) continue;
      const r = await this.platform.killProcess(p.pid);
      if (r.ok) closed += 1;
    }
    return closed;
  }

  async closePid(pid: number): Promise<boolean> {
    const r = await this.platform.killProcess(pid);
    return r.ok;
  }

  dispose(): void {
    this.stopSampling();
    this.unwatch?.();
    this.unwatch = null;
    this.processes.clear();
    this.previous.clear();
    this.previousAt.clear();
    this.removeAllListeners();
  }
}

/** Keeps a percentage inside 0..100 and never returns NaN. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
