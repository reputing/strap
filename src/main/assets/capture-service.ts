import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { CaptureEvent } from '@shared/types';
import { Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, writeFileAtomic } from '@main/core/fs-utils';
import type { AssetService } from './asset-service';
import { assetIdFromUrl, sniffAsset } from './asset-types';
import { BoundedQueue } from './bounded-queue';

export type CaptureSource = 'proxy' | 'roblox-cache' | 'none';

interface PendingCapture {
  assetId: string;
  url: string;
  data: Buffer | null;
  origin: 'proxy' | 'roblox-cache';
}

/** Events kept in memory for the live view. Older ones live in the index. */
const RING_SIZE = 2000;
const QUEUE_CAPACITY = 512;
/** Largest response body we will hash and store from a capture. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/**
 * Live asset capture.
 *
 * Two sources feed it:
 *
 *   proxy        — authoritative. Sees the request URL, the asset id and the
 *                  response bytes. Requires the interception engine.
 *   roblox-cache — passive. Watches Roblox's own temporary HTTP cache and
 *                  indexes what appears there. Needs no privileges and no
 *                  certificate, but newer clients strip request metadata from
 *                  those files, so it often cannot attribute an asset id. It is
 *                  reported as a degraded source rather than presented as equal.
 *
 * Ingestion is asynchronous and bounded, so a busy experience cannot make the
 * capture view stutter or the process grow without limit.
 */
export class CaptureService extends EventEmitter {
  private active = false;
  private source: CaptureSource = 'none';
  private readonly ring: CaptureEvent[] = [];
  private watcher: FSWatcher | null = null;
  private readonly seenFiles = new Set<string>();
  private readonly queue: BoundedQueue<PendingCapture>;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingEmit: CaptureEvent[] = [];

  constructor(
    private readonly paths: BlossomPaths,
    private readonly assets: AssetService,
    private readonly log: ScopedLogger
  ) {
    super();
    this.setMaxListeners(20);
    this.queue = new BoundedQueue<PendingCapture>(
      QUEUE_CAPACITY,
      (item) => this.ingest(item),
      (_item, total) => {
        // Report the first drop and then every thousandth, so a sustained
        // overload is visible without flooding the log.
        if (total === 1 || total % 1000 === 0) {
          this.log.warn('Capture is running behind and is dropping the oldest events', { dropped: total });
        }
      }
    );
  }

  get isActive(): boolean {
    return this.active;
  }

  state(): { active: boolean; count: number; dropped: number; source: CaptureSource } {
    return {
      active: this.active,
      count: this.queue.processed,
      dropped: this.queue.dropped,
      source: this.source
    };
  }

  /**
   * Starts capturing. `proxyActive` decides which source is used: the proxy
   * when it is running, the passive cache watcher otherwise.
   */
  async start(proxyActive: boolean): Promise<Result<void>> {
    if (this.active) return Ok(undefined);
    this.active = true;
    this.queue.resetCounters();

    if (proxyActive) {
      this.source = 'proxy';
      this.log.info('Asset capture started', { source: 'interception proxy' });
    } else {
      const watching = await this.startCacheWatcher();
      this.source = watching ? 'roblox-cache' : 'none';
      this.log.info('Asset capture started', {
        source: watching ? "Roblox's own cache (limited)" : 'none available'
      });
    }

    this.emit('state', this.state());
    return Ok(undefined);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.watcher?.close();
    this.watcher = null;
    this.source = 'none';
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.flushPending();
    this.log.info('Asset capture stopped', { captured: this.queue.processed, dropped: this.queue.dropped });
    this.emit('state', this.state());
  }

  /** Called by the interception engine for every request it handles. */
  record(event: CaptureEvent, data?: Buffer | null): void {
    if (!this.active) return;

    this.push(event);
    if (data && data.length && data.length <= MAX_CAPTURE_BYTES) {
      this.queue.push({ assetId: event.assetId, url: event.url, data, origin: 'proxy' });
    }
  }

  /** Newest events first. */
  recent(limit = 200): CaptureEvent[] {
    return this.ring.slice(-Math.min(limit, RING_SIZE)).reverse();
  }

  clear(): void {
    this.ring.length = 0;
    this.queue.clear();
    this.queue.resetCounters();
    this.emit('state', this.state());
  }

  async exportEvents(path?: string): Promise<Result<{ path: string; count: number }>> {
    const target = path ?? join(this.paths.exports, `capture-${Date.now()}.json`);
    await ensureDir(this.paths.exports);
    const events = this.recent(RING_SIZE);
    await writeFileAtomic(target, JSON.stringify({ exportedAt: Date.now(), events }, null, 2));
    return Ok({ path: target, count: events.length });
  }

  private push(event: CaptureEvent): void {
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();

    // Coalesce emissions: a busy load produces hundreds of events a second, and
    // sending each one across IPC individually is what makes a live view stall.
    this.pendingEmit.push(event);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPending(), 150);
      this.flushTimer.unref?.();
    }
  }

  private flushPending(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.pendingEmit.length) return;
    const batch = this.pendingEmit;
    this.pendingEmit = [];
    this.emit('events', batch);
  }

  private async ingest(item: PendingCapture): Promise<void> {
    if (!item.data || !this.assets.available) return;
    await this.assets.store(item.assetId, item.data, {
      sourceUrl: item.url,
      origin: item.origin
    });
  }

  /**
   * Watches Roblox's own HTTP cache directory. Files that appear there are
   * indexed by content; where a request URL can still be recovered from the
   * file we use it, and where it cannot the asset is recorded under its content
   * hash so it is at least browsable.
   */
  private async startCacheWatcher(): Promise<boolean> {
    const dir = join(this.paths.robloxTemp, 'http');
    try {
      await fs.access(dir);
    } catch {
      this.log.debug('Roblox has no temporary cache directory to watch', { dir });
      return false;
    }

    try {
      this.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename || !this.active) return;
        const name = String(filename);
        if (this.seenFiles.has(name)) return;
        this.seenFiles.add(name);
        // The client writes the file after creating it; give it a moment.
        const t = setTimeout(() => { void this.ingestCacheFile(join(dir, name)); }, 250);
        t.unref?.();
      });
      this.watcher.on('error', () => { this.watcher = null; });

      // Keep the seen-set from growing without bound over a long session.
      if (this.seenFiles.size > 50_000) this.seenFiles.clear();
      return true;
    } catch {
      return false;
    }
  }

  private async ingestCacheFile(path: string): Promise<void> {
    let data: Buffer;
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CAPTURE_BYTES) return;
      data = await fs.readFile(path);
    } catch {
      return;
    }

    const { body, url } = splitRobloxCacheEntry(data);
    const assetId = url ? assetIdFromUrl(url) : null;
    const sniffed = sniffAsset(body.subarray(0, 4096));

    // Without an id the asset is keyed by its content hash so it stays
    // browsable, and the UI shows it as "no id recovered" rather than inventing one.
    const key = assetId ?? `hash:${(await import('node:crypto')).createHash('sha256').update(body).digest('hex').slice(0, 16)}`;

    this.push({
      at: Date.now(),
      assetId: key,
      assetType: sniffed.type,
      url: url ?? path,
      sizeBytes: body.length,
      outcome: 'passthrough',
      ruleId: null,
      overheadMs: null
    });

    this.queue.push({ assetId: key, url: url ?? path, data: body, origin: 'roblox-cache' });
  }

  dispose(): void {
    void this.stop();
    this.removeAllListeners();
  }
}

/**
 * Roblox's cache entries historically began with a text header containing the
 * request URL, followed by the response body. Newer clients strip that header.
 *
 * We look for the separator and fall back to treating the whole file as the
 * body — which is correct for the stripped format and harmless for the old one.
 */
export function splitRobloxCacheEntry(data: Buffer): { body: Buffer; url: string | null } {
  const headLimit = Math.min(data.length, 8192);
  const head = data.subarray(0, headLimit).toString('latin1');

  const urlMatch = /https?:\/\/[^\s"'\0<>]{8,512}/.exec(head);
  const url = urlMatch?.[0] ?? null;

  // A double NUL, or a blank line, separates header from payload in the old format.
  for (const separator of ['\r\n\r\n', '\n\n', '\0\0']) {
    const at = head.indexOf(separator);
    if (at > 0 && at < headLimit - separator.length) {
      return { body: data.subarray(at + separator.length), url };
    }
  }
  return { body: data, url };
}
