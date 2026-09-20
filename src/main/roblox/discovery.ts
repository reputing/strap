import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { RobloxInstallation, RobloxKind } from '@shared/types';

export const PLAYER_EXECUTABLE = 'RobloxPlayerBeta.exe';
export const STUDIO_EXECUTABLE = 'RobloxStudioBeta.exe';

/** Roblox version directories are `version-` plus 16 hex characters. */
export const VERSION_DIR_PATTERN = /^version-[0-9a-f]{16}$/i;

export function isVersionDirectoryName(name: string): boolean {
  return VERSION_DIR_PATTERN.test(name);
}

export function executableFor(kind: RobloxKind): string {
  return kind === 'studio' ? STUDIO_EXECUTABLE : PLAYER_EXECUTABLE;
}

export function kindForExecutable(name: string): RobloxKind | null {
  // Paths reach us from WMI with backslashes regardless of the host platform,
  // so we split on both separators rather than relying on path.basename.
  const lower = (name.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (lower === PLAYER_EXECUTABLE.toLowerCase()) return 'player';
  if (lower === STUDIO_EXECUTABLE.toLowerCase()) return 'studio';
  return null;
}

/**
 * Roblox names its client log files after the client version, e.g.
 *   0.678.1.6780512_20250104T120000Z_Player_ABCDE_last.log
 * which is the cheapest reliable source of the marketing version string for an
 * install that has actually been run.
 */
export function clientVersionFromLogName(fileName: string): string | null {
  const m = /^(\d+\.\d+\.\d+\.\d+)_/.exec(fileName);
  return m?.[1] ?? null;
}

export function compareClientVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface DiscoveryInput {
  /** %LOCALAPPDATA%\Roblox\Versions */
  versionsDirectory: string;
  /** %LOCALAPPDATA%\Roblox\logs */
  logsDirectory: string;
  /** Extra roots to scan, e.g. a Microsoft Store install location. */
  extraRoots?: string[];
}

/**
 * Walks the Roblox installation roots and returns everything that looks like a
 * usable client. Missing directories are not an error: a machine without Roblox
 * installed simply yields an empty list.
 */
export async function discoverInstallations(input: DiscoveryInput): Promise<RobloxInstallation[]> {
  const roots: { path: string; source: RobloxInstallation['source'] }[] = [
    { path: input.versionsDirectory, source: 'user' },
    ...(input.extraRoots ?? []).map((p) => ({ path: p, source: 'store' as const }))
  ];

  const found: RobloxInstallation[] = [];

  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isVersionDirectoryName(entry.name)) continue;
      const directory = join(root.path, entry.name);

      for (const kind of ['player', 'studio'] as const) {
        const executable = join(directory, executableFor(kind));
        let stat;
        try {
          stat = await fs.stat(executable);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;

        found.push({
          kind,
          versionGuid: entry.name,
          clientVersion: null,
          directory,
          executable,
          source: root.source,
          installedAt: stat.mtimeMs
        });
      }
    }
  }

  found.sort((a, b) => b.installedAt - a.installedAt);

  // Roblox's logs name the client version but not the version GUID, so the only
  // attribution we can make honestly is "the version most recently logged
  // belongs to the most recently installed client". Older installs keep a null
  // version rather than an invented one; `RobloxService` fills those in from the
  // client-version API when it can.
  const logged = await readNewestLoggedVersion(input.logsDirectory);
  if (logged) {
    for (const kind of ['player', 'studio'] as const) {
      const newest = found.find((i) => i.kind === kind);
      if (newest) newest.clientVersion = logged;
    }
  }

  return found;
}

/**
 * Returns the newest client version named by a file in Roblox's own log
 * directory, or null when Roblox has never been run on this machine.
 */
export async function readNewestLoggedVersion(logsDirectory: string): Promise<string | null> {
  let files: string[];
  try {
    files = await fs.readdir(logsDirectory);
  } catch {
    return null;
  }

  let newest: { version: string; at: number } | null = null;
  for (const file of files) {
    if (!file.endsWith('.log')) continue;
    const version = clientVersionFromLogName(file);
    if (!version) continue;
    let at: number;
    try {
      at = (await fs.stat(join(logsDirectory, file))).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || at > newest.at) newest = { version, at };
  }
  return newest?.version ?? null;
}

/**
 * Chooses which installation Blossom acts on. Preference order:
 *   1. an explicit pin that still exists,
 *   2. the newest install of the requested kind.
 */
export function selectActive(
  installations: RobloxInstallation[],
  kind: RobloxKind,
  pinnedGuid?: string | null
): RobloxInstallation | null {
  const ofKind = installations.filter((i) => i.kind === kind);
  if (pinnedGuid) {
    const pinned = ofKind.find((i) => i.versionGuid === pinnedGuid);
    if (pinned) return pinned;
  }
  return ofKind[0] ?? null;
}
