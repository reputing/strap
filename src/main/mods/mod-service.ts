import * as fs from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import type { RobloxInstallation } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import type { BackupService } from '@main/backups/backup-service';
import { ensureDir, exists, listFilesRecursive } from '@main/core/fs-utils';

export interface ModFile {
  relativePath: string;
  sizeBytes: number;
  applied: boolean;
  backedUp: boolean;
}

/**
 * Client file overlays.
 *
 * A mod is a file tree under `%LOCALAPPDATA%\BlossomStrap\mods` that mirrors
 * the layout inside a Roblox version directory. Applying copies those files
 * over the client's own; every file that is about to be overwritten — or newly
 * created — is captured in a restore point first, so `restore` is exact rather
 * than best effort.
 *
 * Only paths inside `content` and `ExtraContent` are accepted. Executables and
 * anything outside the client's asset trees are refused: overlaying those is
 * how a "mod manager" turns into something that modifies the program itself.
 */
const ALLOWED_ROOTS = ['content', 'extracontent', 'platformcontent'];

export class ModService {
  constructor(
    private readonly paths: BlossomPaths,
    private readonly backups: BackupService,
    private readonly log: ScopedLogger
  ) {}

  async list(install: RobloxInstallation | null): Promise<ModFile[]> {
    await ensureDir(this.paths.mods);
    const files = await listFilesRecursive(this.paths.mods);
    const out: ModFile[] = [];

    for (const relativePath of files) {
      let sizeBytes = 0;
      try {
        sizeBytes = (await fs.stat(join(this.paths.mods, relativePath))).size;
      } catch {
        continue;
      }
      const target = install ? this.targetPath(install, relativePath) : null;
      out.push({
        relativePath,
        sizeBytes,
        applied: target ? await sameSize(target, sizeBytes) : false,
        backedUp: false
      });
    }
    return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /** Rejects anything that escapes the client's asset trees. */
  private targetPath(install: RobloxInstallation, relativePath: string): string | null {
    const cleaned = normalize(relativePath).replace(/^([\\/])+/, '');
    if (cleaned.startsWith('..')) return null;

    const first = cleaned.split(/[\\/]/)[0]?.toLowerCase() ?? '';
    if (!ALLOWED_ROOTS.includes(first)) return null;

    const full = join(install.directory, cleaned);
    // Belt and braces: the resolved path must still be inside the version dir.
    const rel = relative(install.directory, full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
    return full;
  }

  async apply(install: RobloxInstallation): Promise<Result<{ applied: number; restorePointId: string }>> {
    const files = await listFilesRecursive(this.paths.mods);
    const targets: { source: string; target: string }[] = [];
    const rejected: string[] = [];

    for (const relativePath of files) {
      const target = this.targetPath(install, relativePath);
      if (!target) {
        rejected.push(relativePath);
        continue;
      }
      targets.push({ source: join(this.paths.mods, relativePath), target });
    }

    if (rejected.length) {
      this.log.warn('Some mod files were skipped because they fall outside the client content folders', {
        skipped: rejected.length,
        example: rejected[0]
      });
    }

    if (!targets.length) {
      const point = await this.backups.create('mods: nothing to apply', []);
      return point.ok ? Ok({ applied: 0, restorePointId: point.value }) : point;
    }

    const point = await this.backups.create('Apply client mods', targets.map((t) => t.target));
    if (!point.ok) return point;

    let applied = 0;
    for (const { source, target } of targets) {
      try {
        await ensureDir(dirname(target));
        await fs.copyFile(source, target);
        applied += 1;
      } catch (e) {
        // Roll everything back rather than leaving a half-applied client.
        this.log.error('A mod file could not be applied; rolling back', {
          file: relative(this.paths.mods, source),
          reason: e instanceof Error ? e.message : String(e)
        });
        await this.backups.restore(point.value);
        return Err('io-failure', 'Blossom could not apply the client mods and has put everything back.', {
          remediation: 'Close Roblox and try again.'
        });
      }
    }

    this.log.info('Client mods applied', { applied, restorePoint: point.value });
    return Ok({ applied, restorePointId: point.value });
  }

  /** Puts the client's own files back from the most recent mod restore point. */
  async restore(restorePointId: string): Promise<Result<{ restored: number }>> {
    return this.backups.restore(restorePointId);
  }

  async openFolder(): Promise<string> {
    await ensureDir(this.paths.mods);
    // Seed the expected layout so the folder explains itself on first open.
    for (const root of ['content', 'ExtraContent']) {
      await ensureDir(join(this.paths.mods, root));
    }
    const readme = join(this.paths.mods, 'README.txt');
    if (!(await exists(readme))) {
      await fs.writeFile(
        readme,
        [
          'Blossom Strap — client mods',
          '',
          'Files here mirror the layout inside a Roblox version folder and are',
          'copied over the client when a profile with mods enabled launches.',
          '',
          'Example:',
          '  content\\sounds\\ouch.ogg      replaces the default hurt sound',
          '  content\\textures\\ui\\...      replaces interface artwork',
          '',
          'Only content, ExtraContent and PlatformContent are accepted. Anything',
          'else is ignored, and every file Blossom replaces is backed up first so',
          'Restore puts the client back exactly as Roblox shipped it.',
          ''
        ].join('\n'),
        'utf8'
      );
    }
    return this.paths.mods;
  }
}

async function sameSize(path: string, sizeBytes: number): Promise<boolean> {
  try {
    return (await fs.stat(path)).size === sizeBytes;
  } catch {
    return false;
  }
}
