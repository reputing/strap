import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type {
  AssetPage, AssetQuery, AssetRule, AssetRuleSet, AssetType, CacheStats, CachedAsset
} from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir } from '@main/core/fs-utils';
import { AssetIndex } from '@main/storage/asset-index';
import { BlobStore } from '@main/storage/blob-store';
import { imageDimensions, mimeForType, sniffAsset } from './asset-types';
import { resolve, sortRules, type ResolveRequest, type Resolution } from './resolver';

/** Bytes read from a blob to build a preview or sniff a type. */
const HEAD_BYTES = 64 * 1024;
/** Largest blob inlined into a data URL for the preview pane. */
const PREVIEW_INLINE_LIMIT = 6 * 1024 * 1024;

/**
 * The asset laboratory's service layer: rule sets, rules, the cache index and
 * previews. It owns the index and the blob store, and is the only place that
 * knows both of them exist.
 */
export class AssetService extends EventEmitter {
  readonly index: AssetIndex;
  readonly blobs: BlobStore;
  /** Cached sorted rules for the active sets, rebuilt when rules change. */
  private activeRuleCache: { key: string; rules: AssetRule[] } | null = null;

  constructor(
    private readonly paths: BlossomPaths,
    private readonly log: ScopedLogger
  ) {
    super();
    this.index = new AssetIndex(log.child('index'));
    this.blobs = new BlobStore(paths.blobs);
  }

  async start(): Promise<Result<void>> {
    await ensureDir(this.paths.assets);
    await ensureDir(this.paths.blobs);
    return this.index.open(this.paths.assetIndex);
  }

  get available(): boolean {
    return this.index.available;
  }

  // ── rule sets ──────────────────────────────────────────────────────────

  listSets(): Result<AssetRuleSet[]> {
    return this.index.listSets();
  }

  createSet(name: string, description = ''): Result<AssetRuleSet> {
    const trimmed = name.trim();
    if (!trimmed) return Err('invalid-argument', 'A rule set needs a name.');

    const existing = this.index.listSets();
    const order = existing.ok ? existing.value.length : 0;
    const now = Date.now();

    const created = this.index.createSet({
      id: randomUUID(), name: trimmed, description: description.trim(),
      enabled: true, order, createdAt: now, updatedAt: now
    });
    if (created.ok) {
      this.invalidateRules();
      this.log.info('Asset rule set created', { name: trimmed });
      this.emit('changed');
    }
    return created;
  }

  updateSet(id: string, patch: Partial<AssetRuleSet>): Result<AssetRuleSet> {
    const r = this.index.updateSet(id, patch);
    if (r.ok) { this.invalidateRules(); this.emit('changed'); }
    return r;
  }

  deleteSet(id: string): Result<void> {
    const r = this.index.deleteSet(id);
    if (r.ok) { this.invalidateRules(); this.emit('changed'); }
    return r;
  }

  duplicateSet(id: string, name: string): Result<AssetRuleSet> {
    const source = this.index.getSet(id);
    if (!source.ok) return source;
    const rules = this.index.listRules(id);
    if (!rules.ok) return rules;

    const created = this.createSet(name, source.value.description);
    if (!created.ok) return created;

    for (const rule of rules.value) {
      const copy: AssetRule = { ...rule, id: randomUUID(), setId: created.value.id, hits: 0 };
      const saved = this.index.upsertRule(copy);
      if (!saved.ok) {
        // Leave nothing half-copied.
        this.index.deleteSet(created.value.id);
        return saved;
      }
    }
    this.invalidateRules();
    this.emit('changed');
    return this.index.getSet(created.value.id);
  }

  reorderSets(ids: string[]): Result<AssetRuleSet[]> {
    ids.forEach((id, order) => { this.index.updateSet(id, { order }); });
    this.invalidateRules();
    this.emit('changed');
    return this.index.listSets();
  }

  // ── rules ──────────────────────────────────────────────────────────────

  listRules(setId: string): Result<AssetRule[]> {
    return this.index.listRules(setId);
  }

  upsertRule(patch: Partial<AssetRule> & { setId: string; source: string }): Result<AssetRule> {
    const source = patch.source.trim();
    if (!source) return Err('invalid-argument', 'A rule needs a source asset id or pattern.');

    const action = patch.action ?? 'replace-asset';
    if (action === 'replace-asset' && !/^\d{1,20}$/.test((patch.target ?? '').trim())) {
      return Err('invalid-argument', 'Replacing with an asset needs a numeric asset id.');
    }
    if (action === 'replace-url' && !/^https:\/\//i.test((patch.target ?? '').trim())) {
      return Err('invalid-argument', 'Replacement URLs must start with https://.');
    }

    const now = Date.now();
    const existing = patch.id ? this.index.listRules(patch.setId) : null;
    const previous = existing?.ok ? existing.value.find((r) => r.id === patch.id) : undefined;

    const rule: AssetRule = {
      id: patch.id ?? randomUUID(),
      setId: patch.setId,
      source,
      action,
      target: (patch.target ?? '').trim(),
      assetType: (patch.assetType ?? 'unknown') as AssetType,
      enabled: patch.enabled ?? true,
      priority: Number.isFinite(patch.priority) ? Number(patch.priority) : 0,
      notes: (patch.notes ?? '').slice(0, 1000),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      hits: previous?.hits ?? 0
    };

    const saved = this.index.upsertRule(rule);
    if (saved.ok) { this.invalidateRules(); this.emit('changed'); }
    return saved;
  }

  deleteRule(id: string): Result<void> {
    const r = this.index.deleteRule(id);
    if (r.ok) { this.invalidateRules(); this.emit('changed'); }
    return r;
  }

  /** Rules for the given sets, sorted and memoised for the hot proxy path. */
  activeRules(setIds: string[]): AssetRule[] {
    const key = setIds.join('|');
    if (this.activeRuleCache?.key === key) return this.activeRuleCache.rules;

    const r = this.index.activeRules(setIds);
    const rules = r.ok ? sortRules(r.value) : [];
    this.activeRuleCache = { key, rules };
    return rules;
  }

  invalidateRules(): void {
    this.activeRuleCache = null;
  }

  /** Runs the resolver without performing a request — powers "Test rule". */
  testResolve(request: ResolveRequest, setIds: string[]): Resolution {
    return resolve(request, this.activeRules(setIds));
  }

  // ── cache ──────────────────────────────────────────────────────────────

  query(q: AssetQuery): Result<AssetPage> {
    return this.index.query(q);
  }

  get(assetId: string): Result<CachedAsset> {
    return this.index.getAsset(assetId);
  }

  stats(): Result<CacheStats> {
    return this.index.stats();
  }

  duplicates(): Result<{ hash: string; assetIds: string[]; sizeBytes: number }[]> {
    return this.index.duplicates();
  }

  /** Stores bytes and indexes the asset in one step. */
  async store(
    assetId: string,
    data: Buffer,
    options: { sourceUrl?: string | null; origin?: CachedAsset['origin']; assetType?: AssetType } = {}
  ): Promise<Result<CachedAsset>> {
    const put = await this.blobs.put(data);
    if (!put.ok) return put;

    const head = data.subarray(0, HEAD_BYTES);
    const sniffed = options.assetType && options.assetType !== 'unknown'
      ? { type: options.assetType, mime: mimeForType(options.assetType) }
      : sniffAsset(head);

    const meta: Record<string, string | number> = { mime: sniffed.mime };
    const dims = imageDimensions(head);
    if (dims) { meta['width'] = dims.width; meta['height'] = dims.height; }

    this.index.recordBlob(put.value.hash, data.length);
    const recorded = this.index.upsertAsset({
      assetId,
      assetType: sniffed.type,
      sourceUrl: options.sourceUrl ?? null,
      hash: put.value.hash,
      sizeBytes: data.length,
      origin: options.origin ?? 'proxy',
      meta
    });
    if (!recorded.ok) return recorded;

    this.emit('cache-changed');
    return this.index.getAsset(assetId);
  }

  async importFile(assetId: string, path: string): Promise<Result<CachedAsset>> {
    let data: Buffer;
    try {
      data = await fs.readFile(path);
    } catch {
      return Err('not-found', 'That file could not be read.');
    }
    if (data.length > 512 * 1024 * 1024) {
      return Err('invalid-argument', 'That file is too large to import.');
    }
    return this.store(assetId, data, { origin: 'import', sourceUrl: `file://${basename(path)}` });
  }

  async deleteAssets(assetIds: string[]): Promise<Result<{ deleted: number; bytesFreed: number }>> {
    const removed = this.index.deleteAssets(assetIds);
    if (!removed.ok) return removed;

    let bytesFreed = 0;
    for (const hash of removed.value.hashes) {
      bytesFreed += await this.blobs.size(hash);
      await this.blobs.delete(hash);
    }
    this.emit('cache-changed');
    this.log.info('Assets removed from the cache', { count: removed.value.deleted, bytesFreed });
    return Ok({ deleted: removed.value.deleted, bytesFreed });
  }

  async clearCache(): Promise<Result<{ deleted: number; bytesFreed: number }>> {
    const stats = this.index.stats();
    const bytesFreed = stats.ok ? stats.value.totalBytes : 0;
    const cleared = this.index.clearAssets();
    if (!cleared.ok) return cleared;
    await this.blobs.clear();
    this.emit('cache-changed');
    this.log.info('Asset cache cleared', { deleted: cleared.value, bytesFreed });
    return Ok({ deleted: cleared.value, bytesFreed });
  }

  /** Evicts least-recently-used blobs once the cache passes its byte budget. */
  async enforceBudget(budgetBytes: number): Promise<number> {
    const over = this.index.blobsOverBudget(budgetBytes);
    if (!over.ok || !over.value.length) return 0;

    let freed = 0;
    for (const { hash, sizeBytes } of over.value) {
      if (await this.blobs.delete(hash)) freed += sizeBytes;
    }
    if (freed) this.log.info('Cache trimmed to its budget', { freedBytes: freed, entries: over.value.length });
    return freed;
  }

  async exportAssets(assetIds: string[], directory?: string): Promise<Result<{ exported: number; directory: string }>> {
    const target = directory ?? join(this.paths.exports, `assets-${Date.now()}`);
    try {
      await ensureDir(target);
    } catch {
      return Err('io-failure', 'That export folder could not be created.');
    }

    let exported = 0;
    for (const assetId of assetIds.slice(0, 5000)) {
      const asset = this.index.getAsset(assetId);
      if (!asset.ok || !asset.value.hash) continue;
      const ext = extensionFor(asset.value);
      const r = await this.blobs.exportTo(asset.value.hash, join(target, `${assetId}${ext}`));
      if (r.ok) exported += 1;
    }

    this.log.info('Assets exported', { exported, directory: target });
    return Ok({ exported, directory: target });
  }

  /**
   * Builds a preview payload. Large blobs are refused rather than inlined:
   * holding a 200 MB data URL in the renderer to show a thumbnail is exactly
   * the kind of thing that makes a cache browser unusable.
   */
  async preview(assetId: string, kind: 'auto' | 'raw'): Promise<Result<{
    mime: string; dataUrl: string | null; text: string | null; meta: Record<string, string | number>;
  }>> {
    const asset = this.index.getAsset(assetId);
    if (!asset.ok) return asset;
    if (!asset.value.hash) return Err('not-found', 'That asset has no cached content.');

    const meta: Record<string, string | number> = {
      ...(asset.value.meta ?? {}),
      sizeBytes: asset.value.sizeBytes,
      type: asset.value.assetType
    };

    const head = await this.blobs.head(asset.value.hash, HEAD_BYTES);
    if (!head.ok) return head;

    const sniffed = sniffAsset(head.value);
    const mime = typeof meta['mime'] === 'string' ? String(meta['mime']) : sniffed.mime;
    meta['inferredType'] = sniffed.type;
    meta['confidence'] = sniffed.confidence;

    const dims = imageDimensions(head.value);
    if (dims) { meta['width'] = dims.width; meta['height'] = dims.height; }

    // Text-shaped assets are returned as text; binary ones as a data URL when
    // they are small enough to be worth inlining.
    const textual = kind === 'raw' || sniffed.type === 'json' || sniffed.type === 'text' || sniffed.type === 'mesh';
    if (textual) {
      const text = head.value.toString('utf8').slice(0, 200_000);
      return Ok({ mime: kind === 'raw' ? 'text/plain' : mime, dataUrl: null, text, meta });
    }

    if (asset.value.sizeBytes > PREVIEW_INLINE_LIMIT) {
      meta['previewSkipped'] = 'too-large';
      return Ok({ mime, dataUrl: null, text: null, meta });
    }

    const full = await this.blobs.get(asset.value.hash);
    if (!full.ok) return full;
    return Ok({
      mime,
      dataUrl: `data:${mime};base64,${full.value.toString('base64')}`,
      text: null,
      meta
    });
  }

  blobPath(assetId: string): Result<{ path: string }> {
    const asset = this.index.getAsset(assetId);
    if (!asset.ok) return asset;
    if (!asset.value.hash) return Err('not-found', 'That asset has no cached content.');
    try {
      return Ok({ path: this.blobs.pathFor(asset.value.hash) });
    } catch {
      return Err('io-failure', 'That asset has a malformed cache entry.');
    }
  }

  // ── import/export of rule sets ─────────────────────────────────────────

  exportSet(id: string): Result<string> {
    const set = this.index.getSet(id);
    if (!set.ok) return set;
    const rules = this.index.listRules(id);
    if (!rules.ok) return rules;

    return Ok(JSON.stringify({
      schemaVersion: 1,
      name: set.value.name,
      description: set.value.description,
      rules: rules.value.map((r) => ({
        source: r.source, action: r.action, target: r.target,
        assetType: r.assetType, enabled: r.enabled, priority: r.priority, notes: r.notes
      }))
    }, null, 2) + '\n');
  }

  importSet(json: string): Result<AssetRuleSet> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return Err('parse-failure', 'That file is not valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object') {
      return Err('parse-failure', 'An asset rule set is a JSON object.');
    }

    const doc = parsed as Record<string, unknown>;
    const name = typeof doc['name'] === 'string' && doc['name'].trim() ? doc['name'].trim() : 'Imported rules';
    const created = this.createSet(name, typeof doc['description'] === 'string' ? doc['description'] : '');
    if (!created.ok) return created;

    const rawRules = Array.isArray(doc['rules']) ? doc['rules'] : [];
    let imported = 0;
    let skipped = 0;

    for (const raw of rawRules.slice(0, 20_000)) {
      if (!raw || typeof raw !== 'object') { skipped += 1; continue; }
      const r = raw as Record<string, unknown>;
      const result = this.upsertRule({
        setId: created.value.id,
        source: String(r['source'] ?? ''),
        action: (r['action'] as AssetRule['action']) ?? 'replace-asset',
        target: String(r['target'] ?? ''),
        assetType: (r['assetType'] as AssetType) ?? 'unknown',
        enabled: r['enabled'] !== false,
        priority: Number(r['priority']) || 0,
        notes: String(r['notes'] ?? '')
      });
      if (result.ok) imported += 1;
      else skipped += 1;
    }

    this.log.info('Asset rule set imported', { name, imported, skipped });
    return this.index.getSet(created.value.id);
  }

  close(): void {
    this.index.close();
  }
}

function extensionFor(asset: CachedAsset): string {
  const mime = typeof asset.meta?.['mime'] === 'string' ? String(asset.meta['mime']) : '';
  const fromMime: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
    'audio/flac': '.flac', 'application/json': '.json', 'font/ttf': '.ttf', 'video/mp4': '.mp4',
    'application/x-roblox-mesh': '.mesh', 'application/x-roblox-binary': '.rbxm'
  };
  if (fromMime[mime]) return fromMime[mime];

  const fromType: Record<string, string> = {
    image: '.png', texture: '.ktx', mesh: '.mesh', audio: '.ogg',
    model: '.rbxm', json: '.json', text: '.txt', font: '.ttf', video: '.mp4'
  };
  return fromType[asset.assetType] ?? extname(asset.sourceUrl ?? '') ?? '.bin';
}
