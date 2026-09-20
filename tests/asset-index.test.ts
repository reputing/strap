import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetIndex } from '@main/storage/asset-index';
import { BlobStore } from '@main/storage/blob-store';
import { Logger } from '@main/core/logger';

const scratches: string[] = [];

async function openIndex() {
  const root = await mkdtemp(join(tmpdir(), 'blossom-index-'));
  scratches.push(root);
  const logger = new Logger({ directory: join(root, 'logs'), level: 'critical' });
  const index = new AssetIndex(logger.scope('index'));
  const opened = await index.open(join(root, 'index.db'));
  expect(opened.ok).toBe(true);
  return { root, index };
}

afterEach(async () => {
  for (const s of scratches.splice(0)) await rm(s, { recursive: true, force: true });
});

describe('asset indexing', () => {
  it('inserts an asset and reads it back', async () => {
    const { index } = await openIndex();
    index.upsertAsset({ assetId: '123', assetType: 'image', hash: 'a'.repeat(64), sizeBytes: 100 });

    const got = index.getAsset('123');
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.value.assetType).toBe('image');
      expect(got.value.hitCount).toBe(1);
    }
  });

  it('bumps counters instead of duplicating on re-capture', async () => {
    const { index } = await openIndex();
    index.upsertAsset({ assetId: '123', assetType: 'image', sizeBytes: 100 });
    index.upsertAsset({ assetId: '123', assetType: 'image', sizeBytes: 100 });
    index.upsertAsset({ assetId: '123', assetType: 'image', sizeBytes: 100 });

    const got = index.getAsset('123');
    if (!got.ok) throw new Error('missing');
    expect(got.value.hitCount).toBe(3);
    expect(index.query({}).ok && (index.query({}) as { value: { total: number } }).value.total).toBe(1);
  });

  it('upgrades an unknown type when a later capture identifies it', async () => {
    const { index } = await openIndex();
    index.upsertAsset({ assetId: '1', assetType: 'unknown' });
    index.upsertAsset({ assetId: '1', assetType: 'mesh' });
    const got = index.getAsset('1');
    if (!got.ok) throw new Error('missing');
    expect(got.value.assetType).toBe('mesh');
  });

  it('does not downgrade a known type back to unknown', async () => {
    const { index } = await openIndex();
    index.upsertAsset({ assetId: '1', assetType: 'audio' });
    index.upsertAsset({ assetId: '1', assetType: 'unknown' });
    const got = index.getAsset('1');
    if (!got.ok) throw new Error('missing');
    expect(got.value.assetType).toBe('audio');
  });

  it('reports a missing asset rather than throwing', async () => {
    const { index } = await openIndex();
    const got = index.getAsset('nope');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.error.code).toBe('not-found');
  });
});

describe('cache queries', () => {
  async function seeded() {
    const { index } = await openIndex();
    index.upsertAsset({ assetId: '1', assetType: 'image', sizeBytes: 100, sourceUrl: 'https://c0.rbxcdn.com/aaa' });
    index.upsertAsset({ assetId: '2', assetType: 'audio', sizeBytes: 5000, sourceUrl: 'https://c1.rbxcdn.com/bbb' });
    index.upsertAsset({ assetId: '33', assetType: 'mesh', sizeBytes: 250, sourceUrl: 'https://c2.rbxcdn.com/ccc' });
    return index;
  }

  it('filters by type', async () => {
    const index = await seeded();
    const r = index.query({ types: ['audio'] });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.total).toBe(1);
    expect(r.value.items[0]?.assetId).toBe('2');
  });

  it('filters by size range', async () => {
    const index = await seeded();
    const r = index.query({ minSize: 200, maxSize: 1000 });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.items.map((i) => i.assetId)).toEqual(['33']);
  });

  it('searches id and source url', async () => {
    const index = await seeded();
    const byId = index.query({ search: '3' });
    const byUrl = index.query({ search: 'bbb' });
    if (!byId.ok || !byUrl.ok) throw new Error('query failed');
    expect(byId.value.items.map((i) => i.assetId)).toEqual(['33']);
    expect(byUrl.value.items.map((i) => i.assetId)).toEqual(['2']);
  });

  it('sorts and pages', async () => {
    const index = await seeded();
    const page1 = index.query({ sort: 'size', direction: 'desc', limit: 2, offset: 0 });
    const page2 = index.query({ sort: 'size', direction: 'desc', limit: 2, offset: 2 });
    if (!page1.ok || !page2.ok) throw new Error('query failed');
    expect(page1.value.items.map((i) => i.assetId)).toEqual(['2', '33']);
    expect(page2.value.items.map((i) => i.assetId)).toEqual(['1']);
    expect(page1.value.total).toBe(3);
  });

  it('clamps an absurd limit rather than trying to serve it', async () => {
    const index = await seeded();
    const r = index.query({ limit: 100000 });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.limit).toBe(500);
  });

  it('finds assets sharing a hash', async () => {
    const { index } = await openIndex();
    const hash = 'b'.repeat(64);
    index.upsertAsset({ assetId: '1', assetType: 'image', hash, sizeBytes: 10 });
    index.upsertAsset({ assetId: '2', assetType: 'image', hash, sizeBytes: 10 });
    index.upsertAsset({ assetId: '3', assetType: 'image', hash: 'c'.repeat(64), sizeBytes: 10 });

    const dupes = index.duplicates();
    if (!dupes.ok) throw new Error('failed');
    expect(dupes.value).toHaveLength(1);
    expect(dupes.value[0]?.assetIds.sort()).toEqual(['1', '2']);
  });

  it('only reports a blob orphaned once nothing references it', async () => {
    const { index } = await openIndex();
    const hash = 'd'.repeat(64);
    index.upsertAsset({ assetId: '1', assetType: 'image', hash, sizeBytes: 10 });
    index.upsertAsset({ assetId: '2', assetType: 'image', hash, sizeBytes: 10 });

    const first = index.deleteAssets(['1']);
    if (!first.ok) throw new Error('failed');
    expect(first.value.hashes).toEqual([]);

    const second = index.deleteAssets(['2']);
    if (!second.ok) throw new Error('failed');
    expect(second.value.hashes).toEqual([hash]);
  });
});

describe('rule storage', () => {
  it('cascades rule deletion when a set is removed', async () => {
    const { index } = await openIndex();
    const now = Date.now();
    index.createSet({ id: 's1', name: 'Set', description: '', enabled: true, order: 0, createdAt: now, updatedAt: now });
    index.upsertRule({
      id: 'r1', setId: 's1', source: '1', action: 'replace-asset', target: '2',
      assetType: 'image', enabled: true, priority: 0, notes: '', createdAt: now, updatedAt: now, hits: 0
    });
    expect(index.listRules('s1').ok).toBe(true);

    index.deleteSet('s1');
    const after = index.listRules('s1');
    if (!after.ok) throw new Error('failed');
    expect(after.value).toEqual([]);
  });

  it('refuses a rule pointing at a set that does not exist', async () => {
    const { index } = await openIndex();
    const now = Date.now();
    const r = index.upsertRule({
      id: 'r1', setId: 'ghost', source: '1', action: 'remove', target: '',
      assetType: 'image', enabled: true, priority: 0, notes: '', createdAt: now, updatedAt: now, hits: 0
    });
    expect(r.ok).toBe(false);
  });

  it('returns active rules only from enabled sets, in priority order', async () => {
    const { index } = await openIndex();
    const now = Date.now();
    index.createSet({ id: 'on', name: 'On', description: '', enabled: true, order: 0, createdAt: now, updatedAt: now });
    index.createSet({ id: 'off', name: 'Off', description: '', enabled: false, order: 1, createdAt: now, updatedAt: now });

    const mk = (id: string, setId: string, priority: number, enabled = true) =>
      index.upsertRule({
        id, setId, source: id, action: 'remove', target: '', assetType: 'image',
        enabled, priority, notes: '', createdAt: now, updatedAt: now, hits: 0
      });
    mk('low', 'on', 1); mk('high', 'on', 9); mk('disabled', 'on', 5, false); mk('hidden', 'off', 99);

    const active = index.activeRules(['on', 'off']);
    if (!active.ok) throw new Error('failed');
    expect(active.value.map((r) => r.id)).toEqual(['high', 'low']);
  });
});

describe('blob store', () => {
  it('stores identical bytes once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blossom-blob-'));
    scratches.push(root);
    const store = new BlobStore(join(root, 'blobs'));

    const first = await store.put(Buffer.from('hello'));
    const second = await store.put(Buffer.from('hello'));
    if (!first.ok || !second.ok) throw new Error('failed');

    expect(second.value.hash).toBe(first.value.hash);
    expect(first.value.deduped).toBe(false);
    expect(second.value.deduped).toBe(true);
  });

  it('round-trips content and supports partial reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blossom-blob-'));
    scratches.push(root);
    const store = new BlobStore(join(root, 'blobs'));

    const put = await store.put(Buffer.from('abcdefghij'));
    if (!put.ok) throw new Error('failed');

    const full = await store.get(put.value.hash);
    const head = await store.head(put.value.hash, 4);
    expect(full.ok && full.value.toString()).toBe('abcdefghij');
    expect(head.ok && head.value.toString()).toBe('abcd');
  });

  it('refuses a hash that could escape the store directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blossom-blob-'));
    scratches.push(root);
    const store = new BlobStore(join(root, 'blobs'));
    expect(() => store.pathFor('../../etc/passwd')).toThrow();
    expect(() => store.pathFor('short')).toThrow();
  });

  it('reports a missing blob rather than throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'blossom-blob-'));
    scratches.push(root);
    const store = new BlobStore(join(root, 'blobs'));
    const r = await store.get('f'.repeat(64));
    expect(r.ok).toBe(false);
  });
});
