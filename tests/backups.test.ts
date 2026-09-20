import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '@main/backups/backup-service';
import { createPaths } from '@main/core/paths';
import { Logger } from '@main/core/logger';

const scratches: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'blossom-backup-'));
  scratches.push(root);
  const paths = createPaths(process.env, join(root, 'app'));
  await mkdir(paths.backups, { recursive: true });
  const logger = new Logger({ directory: join(root, 'logs'), level: 'critical' });
  return { root, paths, service: new BackupService(paths, logger.scope('backup')), logger };
}

afterEach(async () => {
  for (const s of scratches.splice(0)) await rm(s, { recursive: true, force: true });
});

describe('restore points', () => {
  it('restores the previous contents of a file', async () => {
    const { root, service } = await setup();
    const target = join(root, 'ClientAppSettings.json');
    await writeFile(target, 'original');

    const point = await service.create('test', [target]);
    expect(point.ok).toBe(true);
    if (!point.ok) return;

    await writeFile(target, 'modified');
    const restored = await service.restore(point.value);
    expect(restored.ok).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('deletes a file that did not exist when the point was taken', async () => {
    const { root, service } = await setup();
    const target = join(root, 'created-by-blossom.json');

    const point = await service.create('test', [target]);
    expect(point.ok).toBe(true);
    if (!point.ok) return;

    await writeFile(target, 'blossom wrote this');
    expect(existsSync(target)).toBe(true);

    await service.restore(point.value);
    expect(existsSync(target)).toBe(false);
  });

  it('handles a mix of existing and missing files in one point', async () => {
    const { root, service } = await setup();
    const existing = join(root, 'a.json');
    const missing = join(root, 'b.json');
    await writeFile(existing, 'A');

    const point = await service.create('mixed', [existing, missing]);
    if (!point.ok) throw new Error('setup failed');

    await writeFile(existing, 'changed');
    await writeFile(missing, 'new');
    await service.restore(point.value);

    expect(await readFile(existing, 'utf8')).toBe('A');
    expect(existsSync(missing)).toBe(false);
  });

  it('recreates a directory that was removed along with the file', async () => {
    const { root, service } = await setup();
    const dir = join(root, 'ClientSettings');
    const target = join(dir, 'ClientAppSettings.json');
    await mkdir(dir, { recursive: true });
    await writeFile(target, 'original');

    const point = await service.create('test', [target]);
    if (!point.ok) throw new Error('setup failed');

    await rm(dir, { recursive: true, force: true });
    const restored = await service.restore(point.value);

    expect(restored.ok).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('original');
  });

  it('lists points newest first and records what they touched', async () => {
    const { root, service } = await setup();
    const a = join(root, 'a');
    await writeFile(a, 'x');
    const first = await service.create('first', [a]);
    const second = await service.create('second', [a]);
    expect(first.ok && second.ok).toBe(true);

    const list = await service.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.reason).toBe('second');
    expect(list[0]?.entries[0]?.existed).toBe(true);
  });

  it('prunes all but the newest points', async () => {
    const { root, service } = await setup();
    const a = join(root, 'a');
    await writeFile(a, 'x');
    for (let i = 0; i < 4; i++) await service.create(`p${i}`, [a]);

    expect(await service.prune(2)).toBe(2);
    expect(await service.list()).toHaveLength(2);
  });

  it('refuses a restore point id that tries to escape the backup folder', async () => {
    const { service } = await setup();
    const r = await service.restore('../../etc');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-argument');

    const d = await service.delete('..');
    expect(d.ok).toBe(false);
  });

  it('reports a missing restore point rather than throwing', async () => {
    const { service } = await setup();
    const r = await service.restore('does-not-exist');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });
});
