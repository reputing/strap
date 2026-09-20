import { join } from 'node:path';
import { arch, cpus, release, totalmem, type as osType } from 'node:os';
import type { BenchmarkResult, DiagnosticsReport, LogRecord } from '@shared/types';
import { Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import { redactPath } from '@main/core/paths';
import { formatRecord, type Logger, type ScopedLogger } from '@main/core/logger';
import { ensureDir, writeFileAtomic } from '@main/core/fs-utils';
import { redact } from '@main/core/redact';
import { runAll, runBenchmark, type BenchmarkContext, type BenchmarkId } from './benchmarks';

export interface DiagnosticsSources {
  appVersion: string;
  channel: string;
  versions: { electron: string; node: string; chrome: string };
  roblox: () => {
    installations: { kind: string; version: string | null; guid: string; path: string }[];
    active: string | null;
    running: number;
    latestKnown: string | null;
  };
  profile: () => { id: string; name: string; valid: boolean; issues: number } | null;
  modifications: () => DiagnosticsReport['modifications'];
  interception: () => DiagnosticsReport['interception'];
  cache: () => { assets: number; bytes: number };
  includeHardware: () => boolean;
  hardwareSummary: () => string | null;
  benchmarkContext: () => BenchmarkContext;
}

/**
 * Diagnostics.
 *
 * Reports are assembled from live service state, never from a cached snapshot,
 * and every path and log line is passed through the same redaction used for
 * log files — a support bundle should be safe to paste into a public channel.
 */
export class DiagnosticsService {
  private readonly benchmarks: BenchmarkResult[] = [];

  constructor(
    private readonly paths: BlossomPaths,
    private readonly logger: Logger,
    private readonly sources: DiagnosticsSources,
    private readonly log: ScopedLogger
  ) {}

  report(): DiagnosticsReport {
    const roblox = this.sources.roblox();
    const includeHardware = this.sources.includeHardware();

    const recent = this.logger.recent(120);
    const errors = recent
      .filter((r) => r.level === 'error' || r.level === 'critical')
      .slice(-15)
      .map((r) => ({ at: r.at, scope: r.scope, message: redact(r.message) }));

    return {
      generatedAt: Date.now(),
      blossom: {
        version: this.sources.appVersion,
        channel: this.sources.channel as DiagnosticsReport['blossom']['channel'],
        electron: this.sources.versions.electron,
        node: this.sources.versions.node,
        chrome: this.sources.versions.chrome
      },
      system: {
        os: includeHardware ? `${osType()} ${release()}` : osType(),
        version: includeHardware ? release() : 'hidden',
        arch: arch(),
        memoryBytes: includeHardware ? totalmem() : 0,
        cpu: includeHardware ? (this.sources.hardwareSummary() ?? cpus()[0]?.model ?? 'Unknown') : 'hidden'
      },
      hardwareIncluded: includeHardware,
      roblox: {
        ...roblox,
        installations: roblox.installations.map((i) => ({ ...i, path: redactPath(i.path) }))
      },
      profile: this.sources.profile(),
      modifications: this.sources.modifications(),
      interception: this.sources.interception(),
      cache: this.sources.cache(),
      recentErrors: errors,
      log: recent.slice(-60).map((r) => redact(formatRecord(r)))
    };
  }

  /** The report rendered as the plain text the Copy button puts on the clipboard. */
  static render(report: DiagnosticsReport): string {
    const lines: string[] = [];
    const push = (label: string, value: unknown) => lines.push(`${label.padEnd(22)}${String(value)}`);

    lines.push('Blossom Strap — diagnostics report');
    lines.push(new Date(report.generatedAt).toISOString());
    lines.push('');

    lines.push('APPLICATION');
    push('Version', `${report.blossom.version} (${report.blossom.channel})`);
    push('Electron', report.blossom.electron);
    push('Node', report.blossom.node);
    push('Chromium', report.blossom.chrome);
    lines.push('');

    lines.push('SYSTEM');
    push('OS', `${report.system.os} ${report.system.version}`);
    push('Architecture', report.system.arch);
    if (report.hardwareIncluded) {
      push('CPU', report.system.cpu);
      push('Memory', `${(report.system.memoryBytes / 1024 ** 3).toFixed(1)} GB`);
    } else {
      push('Hardware', 'excluded by the user');
    }
    lines.push('');

    lines.push('ROBLOX');
    push('Active', report.roblox.active ?? 'not detected');
    push('Running clients', report.roblox.running);
    push('Latest known', report.roblox.latestKnown ?? 'unknown');
    for (const install of report.roblox.installations) {
      lines.push(`  ${install.kind.padEnd(7)} ${(install.version ?? 'unknown').padEnd(18)} ${install.guid}`);
      lines.push(`          ${install.path}`);
    }
    lines.push('');

    lines.push('PROFILE');
    if (report.profile) {
      push('Name', `${report.profile.name} (${report.profile.id})`);
      push('Valid', report.profile.valid ? 'yes' : `no — ${report.profile.issues} issue(s)`);
    } else {
      push('Name', 'none');
    }
    lines.push('');

    lines.push('MODIFICATIONS');
    push('FastFlags', report.modifications.fastFlagCount);
    push('Optimizer preset', report.modifications.optimizerPreset);
    push('Applied actions', report.modifications.appliedActions);
    push('Mod files', report.modifications.modFileCount);
    push('Asset rules', report.modifications.assetRuleCount);
    lines.push('');

    lines.push('INTERCEPTION');
    push('Status', report.interception.status);
    push('Port', report.interception.port ?? 'not listening');
    push('Certificate', report.interception.certificateInstalled ? 'installed in Roblox' : 'not installed');
    lines.push('');

    lines.push('CACHE');
    push('Assets', report.cache.assets);
    push('Size', `${(report.cache.bytes / 1024 ** 2).toFixed(1)} MB`);
    lines.push('');

    if (report.recentErrors.length) {
      lines.push('RECENT ERRORS');
      for (const e of report.recentErrors) {
        lines.push(`  [${new Date(e.at).toISOString()}] ${e.scope}: ${e.message}`);
      }
      lines.push('');
    }

    lines.push('LOG');
    for (const line of report.log) lines.push(`  ${line}`);
    lines.push('');

    return lines.join('\n');
  }

  async save(path?: string): Promise<Result<{ path: string }>> {
    const target = path ?? join(this.paths.exports, `blossom-diagnostics-${Date.now()}.txt`);
    await ensureDir(this.paths.exports);
    await writeFileAtomic(target, DiagnosticsService.render(this.report()));
    this.log.info('Diagnostics report saved', { path: redactPath(target) });
    return Ok({ path: target });
  }

  logs(limit = 200, level?: LogRecord['level']): LogRecord[] {
    return this.logger.recent(limit, level);
  }

  async runBenchmarks(id: BenchmarkId | 'all'): Promise<BenchmarkResult[]> {
    const ctx = this.sources.benchmarkContext();
    const results = id === 'all' ? await runAll(ctx) : await runBenchmark(id, ctx);

    // Keep the most recent result per benchmark id.
    for (const result of results) {
      const index = this.benchmarks.findIndex((b) => b.id === result.id);
      if (index >= 0) this.benchmarks[index] = result;
      else this.benchmarks.push(result);
    }

    this.log.info('Benchmarks completed', { suite: id, results: results.length });
    return results;
  }

  lastBenchmarks(): BenchmarkResult[] {
    return this.benchmarks;
  }
}
