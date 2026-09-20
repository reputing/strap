import { EventEmitter } from 'node:events';
import * as https from 'node:https';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import type { UpdateChannel } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, hashFile } from '@main/core/fs-utils';

export interface ReleaseManifest {
  version: string;
  channel: UpdateChannel;
  notes: string;
  url: string;
  /** SHA-256 of the payload. An update with no hash is refused. */
  sha256: string;
  sizeBytes: number;
  publishedAt: string;
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'staged' | 'failed';
  progress: number;
  version: string | null;
  error: string | null;
}

const MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;

/**
 * Updates.
 *
 * The running executable is never overwritten in place. A payload is downloaded
 * into `updates/`, verified against the SHA-256 in the manifest, and staged.
 * A separate updater process performs the swap after Blossom has exited, and
 * keeps the previous version so a failed start rolls back.
 *
 * A manifest without a hash, or a payload whose hash does not match, is
 * discarded: an update channel is a code execution path and is treated as one.
 */
export class UpdateService extends EventEmitter {
  private state: UpdateState = { phase: 'idle', progress: 0, version: null, error: null };
  private manifest: ReleaseManifest | null = null;
  private stagedPath: string | null = null;

  /** Set after every completed check, successful or not. */
  private lastCheckedAt: number | null = null;

  constructor(
    private readonly paths: BlossomPaths,
    private readonly currentVersion: string,
    private readonly manifestUrl: string | null,
    private readonly log: ScopedLogger
  ) {
    super();
  }

  checkedAt(): number | null {
    return this.lastCheckedAt;
  }

  current(): UpdateState {
    return this.state;
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('changed', this.state);
  }

  async check(channel: UpdateChannel): Promise<Result<{ available: boolean; version: string | null; notes: string | null; channel: string }>> {
    if (!this.manifestUrl) {
      // A development build has no release feed. Say so rather than failing.
      this.set({ phase: 'idle', error: null });
      return Ok({ available: false, version: null, notes: null, channel });
    }

    this.set({ phase: 'checking', progress: 0, error: null });
    this.lastCheckedAt = Date.now();
    this.emit('checked', this.lastCheckedAt);

    const fetched = await fetchJson(`${this.manifestUrl}?channel=${encodeURIComponent(channel)}`);
    if (!fetched.ok) {
      this.set({ phase: 'idle', error: fetched.error.message });
      return fetched;
    }

    const manifest = parseManifest(fetched.value, channel);
    if (!manifest.ok) {
      this.set({ phase: 'idle', error: manifest.error.message });
      return manifest;
    }

    this.manifest = manifest.value;
    const available = compareVersions(manifest.value.version, this.currentVersion) > 0;

    this.set({ phase: 'idle', version: available ? manifest.value.version : null, error: null });
    this.log.info('Update check finished', {
      channel, latest: manifest.value.version, current: this.currentVersion, available
    });

    return Ok({
      available,
      version: available ? manifest.value.version : null,
      notes: available ? manifest.value.notes : null,
      channel
    });
  }

  async download(): Promise<Result<{ staged: boolean; path: string | null }>> {
    const manifest = this.manifest;
    if (!manifest) {
      return Err('not-found', 'Check for updates first.');
    }
    if (!/^https:\/\//i.test(manifest.url)) {
      return Err('validation-failed', 'The update download must use https.');
    }

    this.set({ phase: 'downloading', progress: 0, error: null });
    await ensureDir(this.paths.updates);
    const target = join(this.paths.updates, `blossom-${manifest.version}.pkg`);

    const downloaded = await download(manifest.url, target, manifest.sizeBytes, (progress) => {
      this.set({ progress });
    });
    if (!downloaded.ok) {
      this.set({ phase: 'failed', error: downloaded.error.message });
      await fs.rm(target, { force: true }).catch(() => undefined);
      return downloaded;
    }

    this.set({ phase: 'verifying', progress: 1 });
    const actual = await hashFile(target).catch(() => null);
    if (!actual || actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      this.set({ phase: 'failed', error: 'The downloaded update did not match its published checksum.' });
      this.log.error('Update verification failed; the download was discarded', {
        expected: manifest.sha256.slice(0, 16), actual: actual?.slice(0, 16) ?? 'unreadable'
      });
      return Err('validation-failed', 'The downloaded update did not match its published checksum and has been discarded.', {
        remediation: 'Try again later, or download the release from the project page.'
      });
    }

    this.stagedPath = target;
    this.set({ phase: 'staged', progress: 1, version: manifest.version });
    this.log.info('Update staged', { version: manifest.version });
    return Ok({ staged: true, path: target });
  }

  /**
   * Hands the staged payload to the separate updater process and asks the app
   * to quit. The caller performs the quit so window state is saved first.
   */
  stagedUpdate(): { path: string; version: string } | null {
    if (!this.stagedPath || !this.manifest) return null;
    return { path: this.stagedPath, version: this.manifest.version };
  }

  /** Removes stale payloads from previous runs. */
  async prune(): Promise<void> {
    try {
      const files = await fs.readdir(this.paths.updates);
      for (const file of files) {
        if (this.stagedPath?.endsWith(file)) continue;
        await fs.rm(join(this.paths.updates, file), { force: true }).catch(() => undefined);
      }
    } catch { /* no updates directory yet */ }
  }
}

export function parseManifest(raw: unknown, channel: UpdateChannel): Result<ReleaseManifest> {
  if (!raw || typeof raw !== 'object') {
    return Err('parse-failure', 'The release manifest was not readable.');
  }
  const r = raw as Record<string, unknown>;

  const version = typeof r['version'] === 'string' ? r['version'] : null;
  const url = typeof r['url'] === 'string' ? r['url'] : null;
  const sha256 = typeof r['sha256'] === 'string' ? r['sha256'] : null;

  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    return Err('parse-failure', 'The release manifest has no usable version number.');
  }
  if (!url || !/^https:\/\//i.test(url)) {
    return Err('validation-failed', 'The release manifest does not point at an https download.');
  }
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(sha256)) {
    return Err('validation-failed', 'The release manifest has no valid checksum, so the update was refused.');
  }

  const manifestChannel: UpdateChannel = r['channel'] === 'preview' ? 'preview' : 'stable';
  if (manifestChannel !== channel) {
    // A stable user must never be handed a preview build because the server
    // ignored the channel parameter.
    return Err('validation-failed', `The update server returned a ${manifestChannel} build for the ${channel} channel.`);
  }

  return Ok({
    version,
    channel: manifestChannel,
    notes: typeof r['notes'] === 'string' ? r['notes'] : '',
    url,
    sha256: sha256.toLowerCase(),
    sizeBytes: Number(r['sizeBytes']) || 0,
    publishedAt: typeof r['publishedAt'] === 'string' ? r['publishedAt'] : new Date().toISOString()
  });
}

/** Semantic-ish comparison that tolerates a trailing build number. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  const pb = b.split(/[.\-+]/).map((p) => Number.parseInt(p, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? (pa[i] as number) : 0;
    const y = Number.isFinite(pb[i]) ? (pb[i] as number) : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function fetchJson(url: string): Promise<Result<unknown>> {
  return new Promise((resolveDone) => {
    const req = https.get(url, { headers: { accept: 'application/json', 'user-agent': 'BlossomStrap' } }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume();
        resolveDone(Err('network-failure', `The update server replied with HTTP ${res.statusCode}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes > 1024 * 1024) { req.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolveDone(Ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch {
          resolveDone(Err('parse-failure', 'The release manifest was not valid JSON.'));
        }
      });
    });
    req.setTimeout(15_000, () => { req.destroy(); resolveDone(Err('timeout', 'The update server did not respond.')); });
    req.on('error', (e) => resolveDone(Err('network-failure', 'Blossom could not reach the update server.', { details: { reason: e.message } })));
  });
}

function download(
  url: string,
  target: string,
  expectedBytes: number,
  onProgress: (fraction: number) => void
): Promise<Result<void>> {
  return new Promise((resolveDone) => {
    const req = https.get(url, { headers: { 'user-agent': 'BlossomStrap' } }, (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume();
        resolveDone(Err('network-failure', `The download replied with HTTP ${res.statusCode}.`));
        return;
      }

      const total = Number(res.headers['content-length']) || expectedBytes;
      if (total > MAX_PAYLOAD_BYTES) {
        req.destroy();
        resolveDone(Err('validation-failed', 'The update payload is larger than Blossom will accept.'));
        return;
      }

      const file = createWriteStream(target);
      let received = 0;
      let lastReported = 0;

      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_PAYLOAD_BYTES) {
          req.destroy();
          file.destroy();
          resolveDone(Err('validation-failed', 'The update payload grew beyond its declared size.'));
          return;
        }
        // Report at most every percent; a progress event per chunk is pure noise.
        const fraction = total ? received / total : 0;
        if (fraction - lastReported >= 0.01) {
          lastReported = fraction;
          onProgress(Math.min(1, fraction));
        }
      });

      res.pipe(file);
      file.on('finish', () => { file.close(() => resolveDone(Ok(undefined))); });
      file.on('error', (e) => resolveDone(Err('io-failure', 'The update could not be written to disk.', { details: { reason: e.message } })));
    });

    req.setTimeout(120_000, () => { req.destroy(); resolveDone(Err('timeout', 'The download stalled.')); });
    req.on('error', (e) => resolveDone(Err('network-failure', 'The download failed.', { details: { reason: e.message } })));
  });
}
