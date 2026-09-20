import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { RobloxInstallation } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import type { BackupService } from '@main/backups/backup-service';
import { exists, writeFileAtomic } from '@main/core/fs-utils';

const BEGIN = '# ---- BEGIN BLOSSOM STRAP LOCAL CA ----';
const END = '# ---- END BLOSSOM STRAP LOCAL CA ----';

/**
 * Installs and removes Blossom's CA from Roblox Player's own certificate
 * bundle.
 *
 * Scope is the entire point. The Windows trust store is never touched; the only
 * file changed is `<version>\ssl\cacert.pem`, which belongs to Roblox Player
 * alone. Every other program on the machine — and every other browser and TLS
 * client — is unaffected.
 *
 * The block is fenced with sentinel comments so removal is exact rather than a
 * guess, and the original file is captured in a restore point first.
 */
export class RobloxTrustStore {
  constructor(
    private readonly backups: BackupService,
    private readonly log: ScopedLogger
  ) {}

  static bundlePath(install: RobloxInstallation): string {
    return join(install.directory, 'ssl', 'cacert.pem');
  }

  async isInstalled(install: RobloxInstallation): Promise<boolean> {
    try {
      const pem = await fs.readFile(RobloxTrustStore.bundlePath(install), 'utf8');
      return pem.includes(BEGIN);
    } catch {
      return false;
    }
  }

  /**
   * Appends the CA to Roblox's bundle. Returns what changed so the caller can
   * show it to the user before it happens.
   */
  async install(install: RobloxInstallation, caPem: string): Promise<Result<{ installed: boolean; path: string }>> {
    const path = RobloxTrustStore.bundlePath(install);

    if (!(await exists(path))) {
      return Err('not-found', "Roblox's certificate bundle was not found in this installation.", {
        remediation: 'Run Roblox once so it finishes installing, then try again.',
        details: { path }
      });
    }

    let current: string;
    try {
      current = await fs.readFile(path, 'utf8');
    } catch (e) {
      return Err('io-failure', "Blossom could not read Roblox's certificate bundle.", {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }

    if (current.includes(BEGIN)) {
      // Already present — replace it so a regenerated CA is picked up.
      const removed = stripBlock(current);
      const written = await this.write(path, removed + block(caPem));
      return written.ok ? Ok({ installed: true, path }) : written;
    }

    const point = await this.backups.create('Install the local asset CA into Roblox', [path]);
    if (!point.ok) return point;

    const written = await this.write(path, ensureTrailingNewline(current) + block(caPem));
    if (!written.ok) {
      await this.backups.restore(point.value);
      return written;
    }

    this.log.info("Local CA added to Roblox Player's certificate bundle", { restorePoint: point.value });
    return Ok({ installed: true, path });
  }

  /** Removes exactly the fenced block Blossom added. */
  async remove(install: RobloxInstallation): Promise<Result<{ removed: boolean }>> {
    const path = RobloxTrustStore.bundlePath(install);
    let current: string;
    try {
      current = await fs.readFile(path, 'utf8');
    } catch {
      return Ok({ removed: false });
    }

    if (!current.includes(BEGIN)) return Ok({ removed: false });

    const written = await this.write(path, stripBlock(current));
    if (!written.ok) return written;

    this.log.info("Local CA removed from Roblox Player's certificate bundle");
    return Ok({ removed: true });
  }

  private async write(path: string, content: string): Promise<Result<void>> {
    try {
      await writeFileAtomic(path, content);
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', "Blossom could not write Roblox's certificate bundle.", {
        remediation: 'Close Roblox and try again.',
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }
}

export function block(caPem: string): string {
  return `${BEGIN}\n${ensureTrailingNewline(caPem.trim())}${END}\n`;
}

/**
 * Removes every Blossom block, including a partially written one, and leaves
 * the rest of the file byte-for-byte unchanged.
 */
export function stripBlock(pem: string): string {
  let out = pem;
  for (;;) {
    const start = out.indexOf(BEGIN);
    if (start < 0) break;
    const endIndex = out.indexOf(END, start);
    // A truncated block (no end marker) is removed to the end of the file,
    // which is the only safe reading of it.
    const stop = endIndex < 0 ? out.length : endIndex + END.length + 1;
    out = out.slice(0, start) + out.slice(stop);
  }
  return out;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export const CA_BLOCK_MARKERS = { BEGIN, END };
