import { describe, expect, it } from 'vitest';
import { DiagnosticsService } from '@main/diagnostics/diagnostics-service';
import { runBenchmark } from '@main/diagnostics/benchmarks';
import { createPaths } from '@main/core/paths';
import type { DiagnosticsReport } from '@shared/types';

function report(patch: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    generatedAt: Date.parse('2026-01-01T12:00:00Z'),
    blossom: { version: '0.1.0', channel: 'stable', electron: '33.4.11', node: '20.18.3', chrome: '130.0' },
    system: { os: 'Windows_NT', version: '10.0.22631', arch: 'x64', memoryBytes: 34359738368, cpu: 'Test CPU' },
    hardwareIncluded: true,
    roblox: {
      installations: [{ kind: 'player', version: '0.678.1', guid: 'version-abc', path: 'C:\\Users\\%USER%\\AppData\\Local\\Roblox' }],
      active: '0.678.1', running: 1, latestKnown: '0.678.1'
    },
    profile: { id: 'competitive', name: 'Competitive', valid: true, issues: 0 },
    modifications: { fastFlagCount: 5, optimizerPreset: 'performance', appliedActions: 3, modFileCount: 2, assetRuleCount: 59 },
    interception: { status: 'running', port: 51473, certificateInstalled: true },
    cache: { assets: 14238, bytes: 2847362048 },
    recentErrors: [],
    log: [],
    ...patch
  };
}

describe('diagnostics rendering', () => {
  it('includes the sections someone helping would need', () => {
    const text = DiagnosticsService.render(report());
    for (const heading of ['APPLICATION', 'SYSTEM', 'ROBLOX', 'PROFILE', 'MODIFICATIONS', 'INTERCEPTION', 'CACHE', 'LOG']) {
      expect(text, `missing ${heading}`).toContain(heading);
    }
    expect(text).toContain('0.1.0 (stable)');
    expect(text).toContain('Competitive (competitive)');
  });

  it('says hardware was excluded rather than omitting the row silently', () => {
    const text = DiagnosticsService.render(report({ hardwareIncluded: false }));
    expect(text).toContain('excluded by the user');
    expect(text).not.toContain('Test CPU');
  });

  it('reports an invalid profile with its issue count', () => {
    const text = DiagnosticsService.render(report({
      profile: { id: 'x', name: 'Broken', valid: false, issues: 3 }
    }));
    expect(text).toMatch(/Valid\s+no — 3 issue\(s\)/);
  });

  it('never leaks a user name, ticket or cookie through the log section', () => {
    const text = DiagnosticsService.render(report({
      log: [
        '[12:00:00] INFO  launcher     Launching  args=roblox-player:1+gameinfo:%TICKET%',
        '[12:00:01] INFO  roblox       Found  path=C:\\Users\\%USER%\\AppData'
      ],
      recentErrors: [{ at: Date.now(), scope: 'net', message: 'auth failed for %USER%' }]
    }));
    // The service redacts on the way in; the renderer must not undo it.
    expect(text).not.toMatch(/gameinfo:[A-Za-z0-9]{6,}/);
    expect(text).not.toMatch(/C:\\Users\\(?!%USER%)/);
  });

  it('states a missing profile rather than rendering undefined', () => {
    const text = DiagnosticsService.render(report({ profile: null }));
    expect(text).toContain('Name                  none');
    expect(text).not.toContain('undefined');
  });

  it('marks a port that is not listening', () => {
    const text = DiagnosticsService.render(report({
      interception: { status: 'stopped', port: null, certificateInstalled: false }
    }));
    expect(text).toContain('not listening');
    expect(text).toContain('not installed');
  });
});

describe('benchmarks', () => {
  const ctx = {
    paths: createPaths(process.env, '/tmp/blossom-bench-test'),
    startupMs: 282,
    lastLaunchMs: null,
    cacheHitRate: null,
    interceptionOverheadMs: null,
    configurationSize: { flags: 5, rules: 59, profiles: 4 }
  };

  it('reports a measurement it has', async () => {
    const [result] = await runBenchmark('startup', ctx);
    expect(result?.value).toBe(282);
    expect(result?.unit).toBe('ms');
    expect(result?.samples).toBe(1);
  });

  it('reports unavailable as -1 with zero samples, never as zero', async () => {
    const [launch] = await runBenchmark('launch-time', ctx);
    expect(launch?.value).toBe(-1);
    expect(launch?.samples).toBe(0);
    expect(launch?.detail).toMatch(/has not been launched/);

    const assets = await runBenchmark('asset-loading', ctx);
    const hitRate = assets.find((r) => r.id === 'asset.hit-rate');
    expect(hitRate?.value).toBe(-1);
    expect(hitRate?.samples).toBe(0);
  });

  it('measures real work for memory and configuration', async () => {
    const memory = await runBenchmark('memory', ctx);
    expect(memory[0]?.value).toBeGreaterThan(0);
    expect(memory[0]?.unit).toBe('bytes');

    const config = await runBenchmark('configuration', ctx);
    const parse = config.find((r) => r.id === 'config.parse');
    expect(parse?.samples).toBe(200);
    expect(parse?.value).toBeGreaterThanOrEqual(0);
    expect(config.find((r) => r.id === 'config.profiles')?.value).toBe(4);
  });

  it('carries a unit on every result', async () => {
    for (const id of ['startup', 'memory', 'asset-loading', 'configuration', 'launch-time'] as const) {
      for (const result of await runBenchmark(id, ctx)) {
        expect(['ms', 'bytes', 'percent', 'count', 'ratio'], result.id).toContain(result.unit);
        expect(result.detail.length, result.id).toBeGreaterThan(10);
      }
    }
  });
});
