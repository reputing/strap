import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  clientVersionFromLogName, compareClientVersions, discoverInstallations,
  isVersionDirectoryName, kindForExecutable, readNewestLoggedVersion, selectActive
} from '@main/roblox/discovery';
import { rm } from 'node:fs/promises';

const roots: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'blossom-test-'));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('version directory naming', () => {
  it('accepts exactly the shape Roblox uses', () => {
    expect(isVersionDirectoryName('version-0123456789abcdef')).toBe(true);
    expect(isVersionDirectoryName('version-0123456789ABCDEF')).toBe(true);
    expect(isVersionDirectoryName('version-short')).toBe(false);
    expect(isVersionDirectoryName('versions-0123456789abcdef')).toBe(false);
    expect(isVersionDirectoryName('version-0123456789abcdefg')).toBe(false);
  });

  it('maps executables to the right client kind', () => {
    expect(kindForExecutable('RobloxPlayerBeta.exe')).toBe('player');
    expect(kindForExecutable('C:\\x\\RobloxStudioBeta.exe')).toBe('studio');
    expect(kindForExecutable('RobloxPlayerLauncher.exe')).toBeNull();
  });
});

describe('client version strings', () => {
  it('reads the version out of a Roblox log file name', () => {
    expect(clientVersionFromLogName('0.678.1.6780512_20250104T120000Z_Player_ABC_last.log'))
      .toBe('0.678.1.6780512');
    expect(clientVersionFromLogName('something-else.log')).toBeNull();
  });

  it('orders versions numerically, not lexically', () => {
    expect(compareClientVersions('0.678.1.100', '0.678.1.99')).toBe(1);
    expect(compareClientVersions('0.9.0.0', '0.10.0.0')).toBe(-1);
    expect(compareClientVersions('0.678.1.6780512', '0.678.1.6780512')).toBe(0);
    expect(compareClientVersions('0.678.1', '0.678.1.0')).toBe(0);
  });
});

describe('installation discovery', () => {
  it('returns nothing when Roblox is not installed', async () => {
    const dir = await scratch();
    const found = await discoverInstallations({
      versionsDirectory: join(dir, 'nope'),
      logsDirectory: join(dir, 'also-nope')
    });
    expect(found).toEqual([]);
  });

  it('finds player and studio installs and sorts newest first', async () => {
    const dir = await scratch();
    const versions = join(dir, 'Versions');
    const older = join(versions, 'version-aaaaaaaaaaaaaaaa');
    const newer = join(versions, 'version-bbbbbbbbbbbbbbbb');
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(join(older, 'RobloxPlayerBeta.exe'), 'x');
    await writeFile(join(newer, 'RobloxPlayerBeta.exe'), 'x');
    await writeFile(join(newer, 'RobloxStudioBeta.exe'), 'x');

    const past = new Date(Date.now() - 86_400_000);
    await utimes(join(older, 'RobloxPlayerBeta.exe'), past, past);

    const found = await discoverInstallations({
      versionsDirectory: versions,
      logsDirectory: join(dir, 'logs')
    });

    expect(found).toHaveLength(3);
    expect(found[0]?.versionGuid).toBe('version-bbbbbbbbbbbbbbbb');
    expect(found.filter((f) => f.kind === 'studio')).toHaveLength(1);
    expect(found.every((f) => f.source === 'user')).toBe(true);
  });

  it('ignores directories that are not version folders', async () => {
    const dir = await scratch();
    const versions = join(dir, 'Versions');
    await mkdir(join(versions, 'Downloads'), { recursive: true });
    await writeFile(join(versions, 'Downloads', 'RobloxPlayerBeta.exe'), 'x');

    const found = await discoverInstallations({ versionsDirectory: versions, logsDirectory: dir });
    expect(found).toEqual([]);
  });

  it('attributes the newest logged version to the newest install only', async () => {
    const dir = await scratch();
    const versions = join(dir, 'Versions');
    const logs = join(dir, 'logs');
    await mkdir(join(versions, 'version-cccccccccccccccc'), { recursive: true });
    await mkdir(join(versions, 'version-dddddddddddddddd'), { recursive: true });
    await mkdir(logs, { recursive: true });
    await writeFile(join(versions, 'version-cccccccccccccccc', 'RobloxPlayerBeta.exe'), 'x');
    await writeFile(join(versions, 'version-dddddddddddddddd', 'RobloxPlayerBeta.exe'), 'x');
    await writeFile(join(logs, '0.678.1.6780512_20250104T120000Z_Player_ABC_last.log'), 'x');

    const old = new Date(Date.now() - 86_400_000);
    await utimes(join(versions, 'version-cccccccccccccccc', 'RobloxPlayerBeta.exe'), old, old);

    const found = await discoverInstallations({ versionsDirectory: versions, logsDirectory: logs });
    expect(found[0]?.clientVersion).toBe('0.678.1.6780512');
    expect(found[1]?.clientVersion).toBeNull();
  });

  it('reads the newest logged version and ignores unrelated files', async () => {
    const dir = await scratch();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.txt'), 'x');
    await writeFile(join(dir, '0.600.0.1_a_last.log'), 'x');
    await writeFile(join(dir, '0.700.0.2_b_last.log'), 'x');
    const past = new Date(Date.now() - 86_400_000);
    await utimes(join(dir, '0.600.0.1_a_last.log'), past, past);

    expect(await readNewestLoggedVersion(dir)).toBe('0.700.0.2');
    expect(await readNewestLoggedVersion(join(dir, 'missing'))).toBeNull();
  });
});

describe('active installation selection', () => {
  const make = (guid: string, kind: 'player' | 'studio', installedAt: number) => ({
    kind, versionGuid: guid, clientVersion: null, directory: `/x/${guid}`,
    executable: `/x/${guid}/exe`, source: 'user' as const, installedAt
  });

  it('prefers a pin that still exists', () => {
    const list = [make('a', 'player', 2), make('b', 'player', 1)];
    expect(selectActive(list, 'player', 'b')?.versionGuid).toBe('b');
  });

  it('falls back to the first of the kind when the pin is gone', () => {
    const list = [make('a', 'player', 2), make('b', 'studio', 1)];
    expect(selectActive(list, 'player', 'gone')?.versionGuid).toBe('a');
    expect(selectActive(list, 'studio', 'gone')?.versionGuid).toBe('b');
  });

  it('returns null when nothing of that kind is installed', () => {
    expect(selectActive([make('a', 'player', 1)], 'studio')).toBeNull();
    expect(selectActive([], 'player')).toBeNull();
  });
});
