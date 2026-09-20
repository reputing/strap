import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BenchmarkResult } from '@shared/types';
import type { BlossomPaths } from '@main/core/paths';
import { ensureDir, hashBuffer } from '@main/core/fs-utils';

export type BenchmarkId = 'startup' | 'memory' | 'asset-loading' | 'configuration' | 'launch-time';

export interface BenchmarkContext {
  paths: BlossomPaths;
  /** Milliseconds from process start to the first window being ready. */
  startupMs: number | null;
  /** Milliseconds of the most recent Roblox launch, if one has happened. */
  lastLaunchMs: number | null;
  /** Cache hit rate over the current session, 0..1. */
  cacheHitRate: number | null;
  /** Mean milliseconds the proxy added per intercepted request. */
  interceptionOverheadMs: number | null;
  /** Number of flags and rules the configuration currently holds. */
  configurationSize: { flags: number; rules: number; profiles: number };
}

/**
 * Benchmarks that measure real work.
 *
 * Every result carries its unit and its sample count, so the UI never has to
 * guess what a number means, and a measurement that could not be taken is
 * reported as unavailable rather than as zero.
 */
export async function runBenchmark(id: BenchmarkId, ctx: BenchmarkContext): Promise<BenchmarkResult[]> {
  switch (id) {
    case 'startup': return [startup(ctx)];
    case 'memory': return memory();
    case 'asset-loading': return assetLoading(ctx);
    case 'configuration': return configuration(ctx);
    case 'launch-time': return [launchTime(ctx)];
    default: return [];
  }
}

export async function runAll(ctx: BenchmarkContext): Promise<BenchmarkResult[]> {
  const ids: BenchmarkId[] = ['startup', 'memory', 'asset-loading', 'configuration', 'launch-time'];
  const out: BenchmarkResult[] = [];
  for (const id of ids) out.push(...(await runBenchmark(id, ctx)));
  return out;
}

function startup(ctx: BenchmarkContext): BenchmarkResult {
  return {
    id: 'startup.time',
    name: 'Blossom startup',
    unit: 'ms',
    value: ctx.startupMs ?? -1,
    samples: ctx.startupMs === null ? 0 : 1,
    detail: ctx.startupMs === null
      ? 'Not measured in this session.'
      : 'From process start to the main window being ready to show.',
    ranAt: Date.now()
  };
}

function memory(): BenchmarkResult[] {
  const usage = process.memoryUsage();
  return [
    {
      id: 'memory.resident',
      name: 'Blossom resident memory',
      unit: 'bytes',
      value: usage.rss,
      samples: 1,
      detail: 'Resident set size of the main process. Renderer processes are counted separately by Windows.',
      ranAt: Date.now()
    },
    {
      id: 'memory.heap',
      name: 'Blossom JavaScript heap',
      unit: 'bytes',
      value: usage.heapUsed,
      samples: 1,
      detail: 'Live JavaScript objects in the main process.',
      ranAt: Date.now()
    }
  ];
}

/**
 * Measures the disk and hashing path the asset cache actually uses: write,
 * read back, hash. Uses a temporary file under Blossom's own folder so it
 * measures the same volume the cache lives on.
 */
async function assetLoading(ctx: BenchmarkContext): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const dir = join(ctx.paths.root, 'bench');
  const samples = 24;
  const payload = randomBytes(256 * 1024);

  try {
    await ensureDir(dir);
    const path = join(dir, 'bench.bin');

    const writeStart = performance.now();
    for (let i = 0; i < samples; i++) await fs.writeFile(path, payload);
    const writeMs = (performance.now() - writeStart) / samples;

    const readStart = performance.now();
    for (let i = 0; i < samples; i++) await fs.readFile(path);
    const readMs = (performance.now() - readStart) / samples;

    const hashStart = performance.now();
    for (let i = 0; i < samples; i++) hashBuffer(payload);
    const hashMs = (performance.now() - hashStart) / samples;

    await fs.rm(dir, { recursive: true, force: true });

    results.push(
      {
        id: 'asset.write', name: 'Cache write (256 KB)', unit: 'ms',
        value: round(writeMs), samples,
        detail: 'Mean time to write one cache-sized asset to the Blossom folder.', ranAt: Date.now()
      },
      {
        id: 'asset.read', name: 'Cache read (256 KB)', unit: 'ms',
        value: round(readMs), samples,
        detail: 'Mean time to read one cached asset back.', ranAt: Date.now()
      },
      {
        id: 'asset.hash', name: 'Content hash (256 KB)', unit: 'ms',
        value: round(hashMs), samples,
        detail: 'Mean SHA-256 time. This is the deduplication cost per captured asset.', ranAt: Date.now()
      }
    );
  } catch {
    results.push({
      id: 'asset.write', name: 'Cache write (256 KB)', unit: 'ms', value: -1, samples: 0,
      detail: 'The benchmark could not write to the Blossom folder.', ranAt: Date.now()
    });
  }

  results.push({
    id: 'asset.hit-rate', name: 'Cache hit rate', unit: 'ratio',
    value: ctx.cacheHitRate ?? -1,
    samples: ctx.cacheHitRate === null ? 0 : 1,
    detail: ctx.cacheHitRate === null
      ? 'No interception traffic has been seen in this session.'
      : 'Share of intercepted requests served from the local cache.',
    ranAt: Date.now()
  });

  results.push({
    id: 'asset.overhead', name: 'Interception overhead', unit: 'ms',
    value: ctx.interceptionOverheadMs ?? -1,
    samples: ctx.interceptionOverheadMs === null ? 0 : 1,
    detail: ctx.interceptionOverheadMs === null
      ? 'The interception engine has not handled any requests in this session.'
      : 'Mean milliseconds Blossom added to each intercepted request.',
    ranAt: Date.now()
  });

  return results;
}

/** Measures how long it takes to serialise and re-parse the configuration. */
async function configuration(ctx: BenchmarkContext): Promise<BenchmarkResult[]> {
  const samples = 200;
  const document = {
    flags: Object.fromEntries(Array.from({ length: ctx.configurationSize.flags || 25 }, (_, i) => [`FFlagBench${i}`, 'True'])),
    rules: Array.from({ length: Math.min(ctx.configurationSize.rules || 50, 2000) }, (_, i) => ({
      id: `rule-${i}`, source: String(1000 + i), action: 'replace-asset', target: String(2000 + i)
    }))
  };
  const json = JSON.stringify(document);

  const start = performance.now();
  for (let i = 0; i < samples; i++) JSON.parse(json);
  const parseMs = (performance.now() - start) / samples;

  return [
    {
      id: 'config.parse', name: 'Configuration parse', unit: 'ms',
      value: round(parseMs), samples,
      detail: `Mean time to parse a configuration of ${Object.keys(document.flags).length} flags and ${document.rules.length} rules.`,
      ranAt: Date.now()
    },
    {
      id: 'config.size', name: 'Configuration size', unit: 'bytes',
      value: Buffer.byteLength(json), samples: 1,
      detail: 'Serialised size of a configuration of this shape.', ranAt: Date.now()
    },
    {
      id: 'config.profiles', name: 'Profiles stored', unit: 'count',
      value: ctx.configurationSize.profiles, samples: 1,
      detail: 'Profiles Blossom is currently managing.', ranAt: Date.now()
    }
  ];
}

function launchTime(ctx: BenchmarkContext): BenchmarkResult {
  return {
    id: 'launch.time', name: 'Last Roblox launch', unit: 'ms',
    value: ctx.lastLaunchMs ?? -1,
    samples: ctx.lastLaunchMs === null ? 0 : 1,
    detail: ctx.lastLaunchMs === null
      ? 'Roblox has not been launched through Blossom in this session.'
      : 'From pressing Launch to the client appearing as a running process, including applying the profile.',
    ranAt: Date.now()
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
