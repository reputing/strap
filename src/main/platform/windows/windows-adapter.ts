import { Err, Ok, type Result } from '@shared/result';
import type { HardwareProfile } from '@shared/types';
import type { ScopedLogger } from '@main/core/logger';
import type { OsProcess, PlatformAdapter, ProcessCounters, ProcessEvent, WindowBounds } from '../types';
import { PowerShellAgent } from './ps-agent';

const PRIORITY_MAP = {
  'normal': 'Normal',
  'above-normal': 'AboveNormal',
  'high': 'High'
} as const;

export class WindowsAdapter implements PlatformAdapter {
  readonly id = 'windows' as const;
  private agentOk = true;
  private readonly agent: PowerShellAgent;
  private readonly listeners = new Set<(e: ProcessEvent) => void>();

  constructor(private readonly log: ScopedLogger) {
    this.agent = new PowerShellAgent(log.child('agent'));
    this.agent.on('unavailable', () => {
      this.agentOk = false;
      this.log.warn('Windows helper is unavailable; process monitoring and hardware details are reduced');
    });
    this.agent.on('agent-event', (msg: Record<string, unknown>) => {
      if (msg['event'] !== 'process') return;
      const event: ProcessEvent =
        msg['kind'] === 'started'
          ? {
            kind: 'started',
            process: {
              pid: Number(msg['pid']),
              name: String(msg['name'] ?? ''),
              executable: (msg['executable'] as string | null) ?? null,
              startedAt: Number(msg['startedAt']) || Date.now()
            }
          }
          : { kind: 'stopped', pid: Number(msg['pid']) };
      for (const l of this.listeners) {
        try { l(event); } catch { /* a bad listener must not break the others */ }
      }
    });
  }

  get operational(): boolean {
    return this.agentOk;
  }

  async init(): Promise<void> {
    const started = await this.agent.start();
    if (!started.ok) {
      this.agentOk = false;
      this.log.warn('Windows helper did not start', { reason: started.error.message });
    }
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    await this.agent.dispose();
  }

  async listProcesses(names: string[]): Promise<Result<OsProcess[]>> {
    const r = await this.agent.request<unknown>('list', { names });
    if (!r.ok) return r;
    const raw = Array.isArray(r.value) ? r.value : r.value ? [r.value] : [];
    return Ok(
      raw
        .map((p) => p as Record<string, unknown>)
        .filter((p) => Number.isFinite(Number(p['pid'])))
        .map((p) => ({
          pid: Number(p['pid']),
          name: String(p['name'] ?? ''),
          executable: (p['executable'] as string | null) ?? null,
          startedAt: Number(p['startedAt']) || Date.now()
        }))
    );
  }

  async watchProcesses(
    names: string[],
    listener: (e: ProcessEvent) => void
  ): Promise<Result<() => void>> {
    const r = await this.agent.request('watch', { names });
    if (!r.ok) return r;
    this.listeners.add(listener);
    return Ok(() => { this.listeners.delete(listener); });
  }

  async sampleProcess(pid: number): Promise<Result<ProcessCounters>> {
    const r = await this.agent.request<Record<string, unknown>>('sample', { pid }, 8000);
    if (!r.ok) return r;
    const v = r.value;
    return Ok({
      pid,
      cpuTimeMs: Number(v['cpuTimeMs']) || 0,
      memoryBytes: Number(v['memoryBytes']) || 0,
      startedAt: Number(v['startedAt']) || Date.now()
    });
  }

  async setPriority(pid: number, priority: 'normal' | 'above-normal' | 'high'): Promise<Result<void>> {
    const r = await this.agent.request('priority', { pid, value: PRIORITY_MAP[priority] });
    return r.ok ? Ok(undefined) : r;
  }

  async setAffinity(pid: number, mask: number): Promise<Result<void>> {
    if (!Number.isInteger(mask) || mask <= 0) {
      return Err('invalid-argument', 'The CPU affinity mask must be a positive whole number.');
    }
    const r = await this.agent.request('affinity', { pid, value: mask });
    return r.ok ? Ok(undefined) : r;
  }

  async killProcess(pid: number): Promise<Result<void>> {
    const r = await this.agent.request('kill', { pid });
    return r.ok ? Ok(undefined) : r;
  }

  async queryHardware(): Promise<Result<HardwareProfile>> {
    const r = await this.agent.request<Record<string, unknown>>('hardware', {}, 25_000);
    if (!r.ok) return r;
    const v = r.value;
    const gpusRaw = v['gpus'];
    const gpus = (Array.isArray(gpusRaw) ? gpusRaw : gpusRaw ? [gpusRaw] : [])
      .map((g) => g as Record<string, unknown>)
      .map((g) => ({
        model: String(g['model'] ?? 'Unknown'),
        vendor: String(g['vendor'] ?? 'Unknown'),
        // Win32_VideoController reports AdapterRAM as a signed 32-bit value, so
        // anything at or above 4 GB comes back wrong. Report null rather than a lie.
        memoryBytes: toGpuMemory(g['memoryBytes'])
      }));

    const totalBytes = Number(v['memoryTotal']) || 0;
    const threads = Number(v['cpuThreads']) || 0;
    const profile: HardwareProfile = {
      cpu: {
        model: String(v['cpuModel'] ?? 'Unknown'),
        cores: Number(v['cpuCores']) || 0,
        threads,
        speedMhz: Number(v['cpuMhz']) || null
      },
      memory: { totalBytes, freeBytes: Number(v['memoryFree']) || 0 },
      gpu: gpus,
      os: {
        name: String(v['osName'] ?? 'Windows'),
        version: String(v['osVersion'] ?? ''),
        build: v['osBuild'] ? String(v['osBuild']) : null,
        arch: String(v['osArch'] ?? 'x64')
      },
      tier: classifyTier(totalBytes, threads, gpus),
      probedAt: Date.now()
    };
    return Ok(profile);
  }

  async getMainWindowBounds(pid: number): Promise<Result<WindowBounds | null>> {
    const r = await this.agent.request<Record<string, unknown> | null>('bounds', { pid }, 5000);
    if (!r.ok) return r;
    const v = r.value;
    if (!v || typeof v !== 'object') return Ok(null);
    const width = Number(v['width']);
    const height = Number(v['height']);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return Ok(null);
    return Ok({ x: Number(v['x']) || 0, y: Number(v['y']) || 0, width, height });
  }

  async isForeground(pid: number): Promise<Result<boolean>> {
    const r = await this.agent.request<Record<string, unknown>>('foreground', { pid }, 5000);
    return r.ok ? Ok(Boolean(r.value['foreground'])) : r;
  }

  async setProtocolHandler(protocol: string, command: string | null): Promise<Result<void>> {
    const r = await this.agent.request('protocol-set', { protocol, command });
    return r.ok ? Ok(undefined) : r;
  }

  async getProtocolHandler(protocol: string): Promise<Result<string | null>> {
    const r = await this.agent.request<Record<string, unknown>>('protocol-get', { protocol });
    return r.ok ? Ok((r.value['value'] as string | null) ?? null) : r;
  }

  async setRunAtLogin(enabled: boolean, command: string): Promise<Result<void>> {
    const r = await this.agent.request('reg-set', {
      path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      name: 'BlossomStrap',
      value: enabled ? command : null
    });
    return r.ok ? Ok(undefined) : r;
  }
}

function toGpuMemory(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // The classic 4 GB wrap-around; treat it as unknown.
  if (n === 4_293_918_720 || n >= 2 ** 32) return null;
  return n;
}

/**
 * A coarse tier used only to pick sensible optimizer defaults. It is
 * intentionally blunt: precise hardware scoring would be a false promise.
 */
export function classifyTier(
  memoryBytes: number,
  threads: number,
  gpus: { vendor: string; model: string }[]
): HardwareProfile['tier'] {
  const gb = memoryBytes / 1024 ** 3;
  const integratedOnly =
    gpus.length > 0 &&
    gpus.every((g) => /intel|uhd|hd graphics|vega \d|radeon graphics|iris/i.test(`${g.vendor} ${g.model}`));

  if (gb < 6 || threads <= 2 || (integratedOnly && gb < 10)) return 'low';
  if (gb >= 16 && threads >= 8 && !integratedOnly) return 'high';
  return 'mid';
}
