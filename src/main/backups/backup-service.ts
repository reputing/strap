import * as fs from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RestorePoint } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, exists, readJsonSafe, writeJsonAtomic } from '@main/core/fs-utils';

interface ManifestEntry {
  /** Absolute path of the original file. */
  path: string;
  /** Whether the file existed when the restore point was taken. */
  existed: boolean;
  /** Name of the copy inside the restore point directory. */
  stored: string | null;
  sizeBytes: number;
}

interface Manifest {
  id: string;
  createdAt: number;
  reason: string;
  restored: boolean;
  entries: ManifestEntry[];
}

/**
 * Restore points.
 *
 * Nothing in Blossom writes to a Roblox-owned file without first capturing it
 * here, including the case where the file does not exist yet — "this file did
 * not exist before we touched it" is exactly as important to record as its old
 * contents, because restoring means deleting it again.
 *
 * Restore points survive process death: an unfinished operation is rolled back
 * on the next start rather than left half-applied.
 */
export class BackupService {
  constructor(
    private readonly paths: BlossomPaths,
    private readonly log: ScopedLogger
  ) {}

  private dirFor(id: string): string {
    return join(this.paths.backups, id);
  }

  private manifestPath(id: string): string {
    return join(this.dirFor(id), 'manifest.json');
  }

  /** Captures the current state of `files` and returns the restore point id. */
  async create(reason: string, files: string[]): Promise<Result<string>> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const dir = this.dirFor(id);

    try {
      await ensureDir(dir);
      const entries: ManifestEntry[] = [];
      let index = 0;

      for (const file of dedupe(files)) {
        index += 1;
        if (await exists(file)) {
          const stored = `${String(index).padStart(3, '0')}-${basename(file)}`;
          await fs.copyFile(file, join(dir, stored));
          const size = (await fs.stat(file)).size;
          entries.push({ path: file, existed: true, stored, sizeBytes: size });
        } else {
          entries.push({ path: file, existed: false, stored: null, sizeBytes: 0 });
        }
      }

      const manifest: Manifest = { id, createdAt: Date.now(), reason, restored: false, entries };
      await writeJsonAtomic(this.manifestPath(id), manifest);
      this.log.info('Restore point created', { id, reason, files: entries.length });
      return Ok(id);
    } catch (e) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      this.log.error('Could not create a restore point', {
        reason: e instanceof Error ? e.message : String(e)
      });
      return Err('io-failure', 'Blossom could not back up the files it was about to change.', {
        remediation: 'Nothing was modified. Check that the Blossom Strap folder is writable.'
      });
    }
  }

  /**
   * Puts every file in the restore point back the way it was. Files that did
   * not exist are deleted again.
   */
  async restore(id: string): Promise<Result<{ restored: number }>> {
    const manifest = await this.readManifest(id);
    if (!manifest.ok) return manifest;

    let restored = 0;
    const failures: string[] = [];

    for (const entry of manifest.value.entries) {
      try {
        if (entry.existed && entry.stored) {
          await ensureDir(dirname(entry.path));
          await fs.copyFile(join(this.dirFor(id), entry.stored), entry.path);
        } else {
          await fs.rm(entry.path, { force: true });
        }
        restored += 1;
      } catch (e) {
        failures.push(`${entry.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    manifest.value.restored = true;
    await writeJsonAtomic(this.manifestPath(id), manifest.value).catch(() => undefined);

    if (failures.length) {
      this.log.warn('Restore finished with failures', { id, restored, failed: failures.length });
      return Err('io-failure', `Blossom restored ${restored} of ${manifest.value.entries.length} files.`, {
        remediation: 'Close Roblox and try again. Files in use cannot be replaced.',
        details: { failures: failures.slice(0, 5) }
      });
    }

    this.log.info('Restore point applied', { id, restored });
    return Ok({ restored });
  }

  async list(): Promise<RestorePoint[]> {
    let ids: string[];
    try {
      ids = await fs.readdir(this.paths.backups);
    } catch {
      return [];
    }

    const out: RestorePoint[] = [];
    for (const id of ids) {
      const m = await this.readManifest(id);
      if (!m.ok) continue;
      out.push({
        id: m.value.id,
        createdAt: m.value.createdAt,
        reason: m.value.reason,
        restored: m.value.restored,
        entries: m.value.entries.map((e) => ({ path: e.path, existed: e.existed, sizeBytes: e.sizeBytes }))
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(id: string): Promise<Result<void>> {
    if (!isSafeId(id)) return Err('invalid-argument', 'That restore point id is not valid.');
    try {
      await fs.rm(this.dirFor(id), { recursive: true, force: true });
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', 'Blossom could not delete that restore point.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Keeps the newest `keep` restore points and deletes the rest. */
  async prune(keep: number): Promise<number> {
    const all = await this.list();
    let deleted = 0;
    for (const point of all.slice(Math.max(0, keep))) {
      const r = await this.delete(point.id);
      if (r.ok) deleted += 1;
    }
    if (deleted) this.log.debug('Pruned old restore points', { deleted, kept: keep });
    return deleted;
  }

  private async readManifest(id: string): Promise<Result<Manifest>> {
    if (!isSafeId(id)) return Err('invalid-argument', 'That restore point id is not valid.');
    const fallback: Manifest | null = null;
    const m = await readJsonSafe<Manifest | null>(this.manifestPath(id), fallback);
    if (!m || !Array.isArray(m.entries)) {
      return Err('not-found', 'That restore point is missing or unreadable.');
    }
    return Ok(m);
  }
}

/** Restore point ids are generated, never user-supplied; reject anything else. */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{4,80}$/.test(id) && !id.includes('..');
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))];
}
