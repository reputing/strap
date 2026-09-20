import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Err, Ok, type Result } from '@shared/result';
import { ensureDir, exists, hashBuffer } from '@main/core/fs-utils';

/**
 * Content-addressed storage for captured and imported asset bytes.
 *
 * Files are named by the SHA-256 of their contents and fanned out two levels
 * deep so no directory holds more than a few hundred entries. Identical bytes
 * are stored once no matter how many asset ids point at them, which is what
 * makes cache deduplication free rather than a background job.
 *
 * Blobs never go inside SQLite: the database holds metadata, the filesystem
 * holds bytes.
 */
export class BlobStore {
  constructor(private readonly root: string) {}

  pathFor(hash: string): string {
    // Callers pass hashes that came out of this class or the database, but a
    // malformed one must not be able to build a path outside the store.
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new Error('Blob hashes are 64 hexadecimal characters.');
    }
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /** Writes bytes and returns their hash. Writing the same bytes twice is free. */
  async put(data: Buffer): Promise<Result<{ hash: string; path: string; deduped: boolean }>> {
    const hash = hashBuffer(data);
    const path = this.pathFor(hash);

    try {
      if (await exists(path)) {
        return Ok({ hash, path, deduped: true });
      }
      await ensureDir(join(this.root, hash.slice(0, 2), hash.slice(2, 4)));
      // Write to a temp name first so a crash cannot leave a short file under a
      // hash that claims to describe it.
      const tmp = `${path}.${process.pid}.tmp`;
      await fs.writeFile(tmp, data);
      await fs.rename(tmp, path);
      return Ok({ hash, path, deduped: false });
    } catch (e) {
      return Err('io-failure', 'Blossom could not store that asset.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  async get(hash: string): Promise<Result<Buffer>> {
    try {
      return Ok(await fs.readFile(this.pathFor(hash)));
    } catch {
      return Err('not-found', 'That asset is no longer in the cache.');
    }
  }

  /** Reads at most `limit` bytes — enough to sniff a type or build a preview. */
  async head(hash: string, limit: number): Promise<Result<Buffer>> {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.pathFor(hash), 'r');
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buf, 0, limit, 0);
      return Ok(buf.subarray(0, bytesRead));
    } catch {
      return Err('not-found', 'That asset is no longer in the cache.');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async has(hash: string): Promise<boolean> {
    try {
      return await exists(this.pathFor(hash));
    } catch {
      return false;
    }
  }

  async size(hash: string): Promise<number> {
    try {
      return (await fs.stat(this.pathFor(hash))).size;
    } catch {
      return 0;
    }
  }

  async delete(hash: string): Promise<boolean> {
    try {
      await fs.rm(this.pathFor(hash), { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Copies a blob out to a destination the user chose. */
  async exportTo(hash: string, destination: string): Promise<Result<void>> {
    try {
      await fs.copyFile(this.pathFor(hash), destination);
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', 'Blossom could not export that asset.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true }).catch(() => undefined);
    await ensureDir(this.root);
  }
}
