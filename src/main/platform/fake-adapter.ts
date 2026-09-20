import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { Err, Ok, type Result } from '@shared/result';
import type { HardwareProfile } from '@shared/types';
import type { OsProcess, PlatformAdapter, ProcessCounters, ProcessEvent, WindowBounds } from './types';
import { classifyTier } from './windows/windows-adapter';

/**
 * Stand-in adapter used by tests and by development on non-Windows hosts.
 *
 * It reports `operational: false` so every surface that depends on real OS
 * integration can say "not available here" instead of inventing data. Tests can
 * drive it directly to simulate Roblox starting and stopping.
 */
export class FakeAdapter implements PlatformAdapter {
  readonly id = 'fake' as const;
  readonly operational = false;

  private readonly processes = new Map<number, OsProcess>();
  private readonly listeners = new Set<(e: ProcessEvent) => void>();
  private counters = new Map<number, ProcessCounters>();
  private bounds: WindowBounds | null = { x: 0, y: 0, width: 1920, height: 1080 };
  private foreground = true;
  private protocols = new Map<string, string>();
  private runAtLogin: string | null = null;

  async init(): Promise<void> { /* nothing to set up */ }
  async dispose(): Promise<void> { this.listeners.clear(); }

  // ── test controls ────────────────────────────────────────────────────
  simulateStart(p: OsProcess): void {
    this.processes.set(p.pid, p);
    this.counters.set(p.pid, { pid: p.pid, cpuTimeMs: 0, memoryBytes: 512 * 1024 * 1024, startedAt: p.startedAt });
    for (const l of this.listeners) l({ kind: 'started', process: p });
  }

  simulateStop(pid: number): void {
    this.processes.delete(pid);
    this.counters.delete(pid);
    for (const l of this.listeners) l({ kind: 'stopped', pid });
  }

  setCounters(pid: number, c: Partial<ProcessCounters>): void {
    const existing = this.counters.get(pid);
    if (existing) this.counters.set(pid, { ...existing, ...c });
  }

  setBounds(b: WindowBounds | null): void { this.bounds = b; }
  setForeground(v: boolean): void { this.foreground = v; }

  // ── adapter surface ──────────────────────────────────────────────────
  async listProcesses(names: string[]): Promise<Result<OsProcess[]>> {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    return Ok([...this.processes.values()].filter((p) => wanted.has(p.name.toLowerCase())));
  }

  async watchProcesses(_names: string[], listener: (e: ProcessEvent) => void): Promise<Result<() => void>> {
    this.listeners.add(listener);
    return Ok(() => { this.listeners.delete(listener); });
  }

  async sampleProcess(pid: number): Promise<Result<ProcessCounters>> {
    const c = this.counters.get(pid);
    return c ? Ok(c) : Err('not-found', `No process with id ${pid}.`);
  }

  async setPriority(pid: number): Promise<Result<void>> {
    return this.processes.has(pid) ? Ok(undefined) : Err('not-found', `No process with id ${pid}.`);
  }

  async setAffinity(pid: number, mask: number): Promise<Result<void>> {
    if (!Number.isInteger(mask) || mask <= 0) return Err('invalid-argument', 'The CPU affinity mask must be a positive whole number.');
    return this.processes.has(pid) ? Ok(undefined) : Err('not-found', `No process with id ${pid}.`);
  }

  async killProcess(pid: number): Promise<Result<void>> {
    if (!this.processes.has(pid)) return Err('not-found', `No process with id ${pid}.`);
    this.simulateStop(pid);
    return Ok(undefined);
  }

  async queryHardware(): Promise<Result<HardwareProfile>> {
    const list = cpus();
    const first = list[0];
    const threads = list.length;
    const total = totalmem();
    return Ok({
      cpu: {
        model: first?.model ?? 'Unknown',
        cores: Math.max(1, Math.floor(threads / 2)),
        threads,
        speedMhz: first?.speed ?? null
      },
      memory: { totalBytes: total, freeBytes: freemem() },
      gpu: [],
      os: { name: platform(), version: release(), build: null, arch: process.arch },
      tier: classifyTier(total, threads, []),
      probedAt: Date.now()
    });
  }

  async getMainWindowBounds(): Promise<Result<WindowBounds | null>> { return Ok(this.bounds); }
  async isForeground(): Promise<Result<boolean>> { return Ok(this.foreground); }

  async setProtocolHandler(protocol: string, command: string | null): Promise<Result<void>> {
    if (command === null) this.protocols.delete(protocol);
    else this.protocols.set(protocol, command);
    return Ok(undefined);
  }

  async getProtocolHandler(protocol: string): Promise<Result<string | null>> {
    return Ok(this.protocols.get(protocol) ?? null);
  }

  async setRunAtLogin(enabled: boolean, command: string): Promise<Result<void>> {
    this.runAtLogin = enabled ? command : null;
    return Ok(undefined);
  }

  getRunAtLogin(): string | null { return this.runAtLogin; }
}
