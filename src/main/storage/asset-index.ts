import type {
  AssetPage, AssetQuery, AssetRule, AssetRuleSet, AssetType, CacheStats, CachedAsset
} from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import { applyMigrations, loadSqlite, type Database } from './database';
import { ensureDir } from '@main/core/fs-utils';
import { dirname } from 'node:path';
import { probeNativeSqlite } from './native-probe';

interface AssetRow {
  asset_id: string; asset_type: string; source_url: string | null; hash: string | null;
  size_bytes: number; first_seen: number; last_seen: number; hit_count: number;
  origin: string; meta: string | null;
}

interface RuleRow {
  id: string; set_id: string; source: string; action: string; target: string;
  asset_type: string; enabled: number; priority: number; notes: string;
  created_at: number; updated_at: number; hits: number;
}

interface SetRow {
  id: string; name: string; description: string; enabled: number;
  sort_order: number; created_at: number; updated_at: number;
}

/**
 * The asset index.
 *
 * SQLite because the cache browser needs search, type filters, size ranges,
 * date ranges, duplicate detection and sorting over tens of thousands of rows,
 * and doing that over a directory listing is exactly the limitation Fleasion's
 * filesystem-shaped cache runs into.
 *
 * Every method returns a Result. If the native module failed to load, the index
 * reports itself unavailable and the rest of the app carries on without a cache
 * rather than refusing to run.
 */
export class AssetIndex {
  private db: Database | null = null;
  private unavailableReason: string | null = null;

  constructor(private readonly log: ScopedLogger) {}

  async open(path: string): Promise<Result<void>> {
    // A native module with the wrong ABI kills the process on first use rather
    // than throwing, so it is exercised in a child process before being
    // trusted here. See native-probe.ts.
    const probe = await probeNativeSqlite(dirname(path), this.log);
    if (!probe.ok) {
      this.unavailableReason = probe.detail;
      return Err('io-failure', 'The asset index is unavailable in this build.', {
        remediation: 'Reinstall Blossom Strap. Everything except the asset cache will keep working.',
        details: { reason: probe.detail }
      });
    }

    const factory = loadSqlite(this.log);
    if (!factory) {
      this.unavailableReason = 'The SQLite module could not be loaded.';
      return Err('io-failure', 'The asset index is unavailable in this build.', {
        remediation: 'Reinstall Blossom Strap. Everything except the asset cache will keep working.'
      });
    }

    try {
      await ensureDir(dirname(path));
      this.db = factory.open(path);
      applyMigrations(this.db, this.log);
      this.log.info('Asset index ready');
      return Ok(undefined);
    } catch (e) {
      this.unavailableReason = e instanceof Error ? e.message : String(e);
      this.db = null;
      return Err('io-failure', 'The asset index could not be opened.', {
        remediation: 'Delete index.db from the Blossom Strap assets folder to rebuild it.',
        details: { reason: this.unavailableReason }
      });
    }
  }

  get available(): boolean {
    return this.db !== null;
  }

  get reason(): string | null {
    return this.unavailableReason;
  }

  private require(): Result<Database> {
    return this.db
      ? Ok(this.db)
      : Err('io-failure', 'The asset index is not available.', {
        details: { reason: this.unavailableReason ?? 'not opened' }
      });
  }

  close(): void {
    try {
      this.db?.close();
    } catch { /* already closed */ }
    this.db = null;
  }

  // ── assets ─────────────────────────────────────────────────────────────

  /**
   * Records that an asset was seen. Re-seeing an asset bumps its counters
   * rather than inserting a duplicate row.
   */
  upsertAsset(asset: {
    assetId: string; assetType: AssetType; sourceUrl?: string | null; hash?: string | null;
    sizeBytes?: number; origin?: CachedAsset['origin']; meta?: Record<string, string | number> | null;
  }): Result<void> {
    const db = this.require();
    if (!db.ok) return db;

    const now = Date.now();
    try {
      db.value
        .prepare(
          `INSERT INTO assets (asset_id, asset_type, source_url, hash, size_bytes, first_seen, last_seen, hit_count, origin, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(asset_id) DO UPDATE SET
             last_seen  = excluded.last_seen,
             hit_count  = assets.hit_count + 1,
             asset_type = CASE WHEN assets.asset_type = 'unknown' THEN excluded.asset_type ELSE assets.asset_type END,
             hash       = COALESCE(excluded.hash, assets.hash),
             size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE assets.size_bytes END,
             source_url = COALESCE(excluded.source_url, assets.source_url),
             meta       = COALESCE(excluded.meta, assets.meta)`
        )
        .run(
          asset.assetId,
          asset.assetType,
          asset.sourceUrl ?? null,
          asset.hash ?? null,
          asset.sizeBytes ?? 0,
          now,
          now,
          asset.origin ?? 'proxy',
          asset.meta ? JSON.stringify(asset.meta) : null
        );
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', 'Blossom could not record that asset.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Bulk insert used by the capture ingester; one transaction per batch. */
  upsertMany(assets: Parameters<AssetIndex['upsertAsset']>[0][]): Result<number> {
    const db = this.require();
    if (!db.ok) return db;
    if (!assets.length) return Ok(0);

    try {
      const run = db.value.transaction((batch: Parameters<AssetIndex['upsertAsset']>[0][]) => {
        for (const a of batch) this.upsertAsset(a);
      });
      run(assets as never);
      return Ok(assets.length);
    } catch (e) {
      return Err('io-failure', 'Blossom could not record that batch of assets.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  getAsset(assetId: string): Result<CachedAsset> {
    const db = this.require();
    if (!db.ok) return db;
    const row = db.value.prepare('SELECT * FROM assets WHERE asset_id = ?').get(assetId) as AssetRow | undefined;
    return row ? Ok(toAsset(row)) : Err('not-found', 'That asset is not in the cache.');
  }

  /**
   * Paged, filtered query. The UI never loads the whole cache: it asks for a
   * window and a total, and virtualises the rest.
   */
  query(q: AssetQuery): Result<AssetPage> {
    const db = this.require();
    if (!db.ok) return db;

    const where: string[] = [];
    const params: unknown[] = [];

    if (q.search?.trim()) {
      where.push('(asset_id LIKE ? OR source_url LIKE ?)');
      const like = `%${q.search.trim()}%`;
      params.push(like, like);
    }
    if (q.types?.length) {
      where.push(`asset_type IN (${q.types.map(() => '?').join(',')})`);
      params.push(...q.types);
    }
    if (typeof q.minSize === 'number') { where.push('size_bytes >= ?'); params.push(q.minSize); }
    if (typeof q.maxSize === 'number') { where.push('size_bytes <= ?'); params.push(q.maxSize); }
    if (typeof q.seenAfter === 'number') { where.push('last_seen >= ?'); params.push(q.seenAfter); }
    if (typeof q.seenBefore === 'number') { where.push('last_seen <= ?'); params.push(q.seenBefore); }
    if (q.origin) { where.push('origin = ?'); params.push(q.origin); }
    if (q.replacedOnly) {
      where.push('EXISTS (SELECT 1 FROM rules r WHERE r.source = assets.asset_id AND r.enabled = 1)');
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const sortColumn = ({
      lastSeen: 'last_seen', firstSeen: 'first_seen', size: 'size_bytes',
      assetId: 'asset_id', hits: 'hit_count'
    } as const)[q.sort ?? 'lastSeen'];
    const direction = q.direction === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const offset = Math.max(0, q.offset ?? 0);

    try {
      const total = Number(
        (db.value.prepare(`SELECT COUNT(*) AS n FROM assets ${clause}`).get(...params) as { n: number }).n
      );
      const rows = db.value
        .prepare(`SELECT * FROM assets ${clause} ORDER BY ${sortColumn} ${direction} LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as AssetRow[];

      return Ok({ items: rows.map(toAsset), total, offset, limit });
    } catch (e) {
      return Err('io-failure', 'That cache query could not be run.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  stats(): Result<CacheStats> {
    const db = this.require();
    if (!db.ok) return db;

    try {
      const totals = db.value
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes, MIN(first_seen) AS oldest, MAX(last_seen) AS newest FROM assets')
        .get() as { n: number; bytes: number; oldest: number | null; newest: number | null };

      const byTypeRows = db.value
        .prepare('SELECT asset_type, COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM assets GROUP BY asset_type')
        .all() as { asset_type: string; n: number; bytes: number }[];

      const blobs = db.value
        .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM blobs')
        .get() as { n: number; bytes: number };

      const byType: CacheStats['byType'] = {};
      for (const r of byTypeRows) byType[r.asset_type] = { count: r.n, bytes: r.bytes };

      return Ok({
        assetCount: totals.n,
        blobCount: blobs.n,
        totalBytes: blobs.bytes || totals.bytes,
        // Bytes the store did not have to write because the content already
        // existed under the same hash.
        duplicateBytesSaved: Math.max(0, totals.bytes - blobs.bytes),
        byType,
        oldest: totals.oldest,
        newest: totals.newest
      });
    } catch (e) {
      return Err('io-failure', 'Cache statistics could not be read.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Groups of assets whose bytes are identical. */
  duplicates(): Result<{ hash: string; assetIds: string[]; sizeBytes: number }[]> {
    const db = this.require();
    if (!db.ok) return db;
    const rows = db.value
      .prepare(
        `SELECT hash, COUNT(*) AS n, MAX(size_bytes) AS size_bytes,
                GROUP_CONCAT(asset_id) AS ids
         FROM assets WHERE hash IS NOT NULL
         GROUP BY hash HAVING n > 1 ORDER BY size_bytes DESC LIMIT 500`
      )
      .all() as { hash: string; n: number; size_bytes: number; ids: string }[];

    return Ok(rows.map((r) => ({ hash: r.hash, assetIds: r.ids.split(','), sizeBytes: r.size_bytes })));
  }

  deleteAssets(assetIds: string[]): Result<{ deleted: number; hashes: string[] }> {
    const db = this.require();
    if (!db.ok) return db;
    if (!assetIds.length) return Ok({ deleted: 0, hashes: [] });

    try {
      const placeholders = assetIds.map(() => '?').join(',');
      const hashRows = db.value
        .prepare(`SELECT DISTINCT hash FROM assets WHERE asset_id IN (${placeholders}) AND hash IS NOT NULL`)
        .all(...assetIds) as { hash: string }[];
      const info = db.value.prepare(`DELETE FROM assets WHERE asset_id IN (${placeholders})`).run(...assetIds);

      // Only report a hash as orphaned once no remaining asset references it.
      const orphaned: string[] = [];
      for (const { hash } of hashRows) {
        const still = db.value.prepare('SELECT COUNT(*) AS n FROM assets WHERE hash = ?').get(hash) as { n: number };
        if (still.n === 0) {
          orphaned.push(hash);
          db.value.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
        }
      }
      return Ok({ deleted: info.changes, hashes: orphaned });
    } catch (e) {
      return Err('io-failure', 'Those assets could not be removed from the index.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  clearAssets(): Result<number> {
    const db = this.require();
    if (!db.ok) return db;
    const info = db.value.prepare('DELETE FROM assets').run();
    db.value.prepare('DELETE FROM blobs').run();
    return Ok(info.changes);
  }

  recordBlob(hash: string, sizeBytes: number): Result<void> {
    const db = this.require();
    if (!db.ok) return db;
    const now = Date.now();
    db.value
      .prepare(
        `INSERT INTO blobs (hash, size_bytes, created_at, last_used, refs) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(hash) DO UPDATE SET last_used = excluded.last_used, refs = blobs.refs + 1`
      )
      .run(hash, sizeBytes, now, now);
    return Ok(undefined);
  }

  /** Least-recently-used blobs past a byte budget, for eviction. */
  blobsOverBudget(budgetBytes: number): Result<{ hash: string; sizeBytes: number }[]> {
    const db = this.require();
    if (!db.ok) return db;
    const rows = db.value
      .prepare('SELECT hash, size_bytes FROM blobs ORDER BY last_used ASC')
      .all() as { hash: string; size_bytes: number }[];

    const total = rows.reduce((s, r) => s + r.size_bytes, 0);
    let over = total - budgetBytes;
    if (over <= 0) return Ok([]);

    const evict: { hash: string; sizeBytes: number }[] = [];
    for (const r of rows) {
      if (over <= 0) break;
      evict.push({ hash: r.hash, sizeBytes: r.size_bytes });
      over -= r.size_bytes;
    }
    return Ok(evict);
  }

  // ── rule sets ──────────────────────────────────────────────────────────

  listSets(): Result<AssetRuleSet[]> {
    const db = this.require();
    if (!db.ok) return db;
    const rows = db.value
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM rules r WHERE r.set_id = s.id) AS rule_count
         FROM rule_sets s ORDER BY s.sort_order ASC, s.name ASC`
      )
      .all() as (SetRow & { rule_count: number })[];
    return Ok(rows.map(toSet));
  }

  getSet(id: string): Result<AssetRuleSet> {
    const db = this.require();
    if (!db.ok) return db;
    const row = db.value
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM rules r WHERE r.set_id = s.id) AS rule_count
         FROM rule_sets s WHERE s.id = ?`
      )
      .get(id) as (SetRow & { rule_count: number }) | undefined;
    return row ? Ok(toSet(row)) : Err('not-found', 'That asset rule set no longer exists.');
  }

  createSet(set: Omit<AssetRuleSet, 'ruleCount'>): Result<AssetRuleSet> {
    const db = this.require();
    if (!db.ok) return db;
    try {
      db.value
        .prepare(
          `INSERT INTO rule_sets (id, name, description, enabled, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(set.id, set.name, set.description, set.enabled ? 1 : 0, set.order, set.createdAt, set.updatedAt);
      return Ok({ ...set, ruleCount: 0 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('UNIQUE')) return Err('already-exists', 'A rule set with that id already exists.');
      return Err('io-failure', 'That rule set could not be created.', { details: { reason: message } });
    }
  }

  updateSet(id: string, patch: Partial<AssetRuleSet>): Result<AssetRuleSet> {
    const db = this.require();
    if (!db.ok) return db;
    const existing = this.getSet(id);
    if (!existing.ok) return existing;

    const next = { ...existing.value, ...patch, id, updatedAt: Date.now() };
    db.value
      .prepare('UPDATE rule_sets SET name = ?, description = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.description, next.enabled ? 1 : 0, next.order, next.updatedAt, id);
    return this.getSet(id);
  }

  deleteSet(id: string): Result<void> {
    const db = this.require();
    if (!db.ok) return db;
    // Rules cascade via the foreign key.
    const info = db.value.prepare('DELETE FROM rule_sets WHERE id = ?').run(id);
    return info.changes ? Ok(undefined) : Err('not-found', 'That asset rule set no longer exists.');
  }

  // ── rules ──────────────────────────────────────────────────────────────

  listRules(setId: string): Result<AssetRule[]> {
    const db = this.require();
    if (!db.ok) return db;
    const rows = db.value
      .prepare('SELECT * FROM rules WHERE set_id = ? ORDER BY priority DESC, created_at ASC')
      .all(setId) as RuleRow[];
    return Ok(rows.map(toRule));
  }

  /** Every enabled rule in every enabled set, in evaluation order. */
  activeRules(setIds: string[]): Result<AssetRule[]> {
    const db = this.require();
    if (!db.ok) return db;
    if (!setIds.length) return Ok([]);

    const placeholders = setIds.map(() => '?').join(',');
    const rows = db.value
      .prepare(
        `SELECT r.* FROM rules r
         JOIN rule_sets s ON s.id = r.set_id
         WHERE r.set_id IN (${placeholders}) AND r.enabled = 1 AND s.enabled = 1
         ORDER BY r.priority DESC, s.sort_order ASC, r.created_at ASC`
      )
      .all(...setIds) as RuleRow[];
    return Ok(rows.map(toRule));
  }

  upsertRule(rule: AssetRule): Result<AssetRule> {
    const db = this.require();
    if (!db.ok) return db;
    try {
      db.value
        .prepare(
          `INSERT INTO rules (id, set_id, source, action, target, asset_type, enabled, priority, notes, created_at, updated_at, hits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source = excluded.source, action = excluded.action, target = excluded.target,
             asset_type = excluded.asset_type, enabled = excluded.enabled,
             priority = excluded.priority, notes = excluded.notes, updated_at = excluded.updated_at`
        )
        .run(
          rule.id, rule.setId, rule.source, rule.action, rule.target, rule.assetType,
          rule.enabled ? 1 : 0, rule.priority, rule.notes, rule.createdAt, rule.updatedAt, rule.hits
        );
      return Ok(rule);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('FOREIGN KEY')) return Err('not-found', 'That rule set no longer exists.');
      return Err('io-failure', 'That rule could not be saved.', { details: { reason: message } });
    }
  }

  deleteRule(id: string): Result<void> {
    const db = this.require();
    if (!db.ok) return db;
    const info = db.value.prepare('DELETE FROM rules WHERE id = ?').run(id);
    return info.changes ? Ok(undefined) : Err('not-found', 'That rule no longer exists.');
  }

  recordRuleHit(id: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(id);
    } catch { /* a hit counter is never worth failing a request over */ }
  }
}

function toAsset(row: AssetRow): CachedAsset {
  let meta: Record<string, string | number> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, string | number>;
    } catch {
      meta = null;
    }
  }
  return {
    assetId: row.asset_id,
    assetType: row.asset_type as AssetType,
    sourceUrl: row.source_url,
    hash: row.hash ?? '',
    sizeBytes: row.size_bytes,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    hitCount: row.hit_count,
    origin: row.origin as CachedAsset['origin'],
    meta
  };
}

function toRule(row: RuleRow): AssetRule {
  return {
    id: row.id, setId: row.set_id, source: row.source,
    action: row.action as AssetRule['action'], target: row.target,
    assetType: row.asset_type as AssetType, enabled: row.enabled === 1,
    priority: row.priority, notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at, hits: row.hits
  };
}

function toSet(row: SetRow & { rule_count: number }): AssetRuleSet {
  return {
    id: row.id, name: row.name, description: row.description,
    enabled: row.enabled === 1, order: row.sort_order,
    createdAt: row.created_at, updatedAt: row.updated_at, ruleCount: row.rule_count
  };
}
