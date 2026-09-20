import type { ScopedLogger } from '@main/core/logger';

/**
 * The narrow slice of SQLite Blossom uses.
 *
 * Declaring it as an interface rather than importing better-sqlite3 everywhere
 * keeps the native module at one boundary. If it fails to load — a mismatched
 * ABI after an Electron upgrade, an antivirus quarantine — the storage layer
 * reports it and the app degrades to "cache unavailable" rather than refusing
 * to start.
 */
export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export interface DatabaseFactory {
  open(path: string): Database;
}

/**
 * Loads better-sqlite3 lazily. Returns null rather than throwing so the caller
 * can decide how to degrade.
 */
export function loadSqlite(log: ScopedLogger): DatabaseFactory | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('better-sqlite3') as new (path: string, opts?: unknown) => Database;
    return {
      open(path: string) {
        const db = new mod(path);
        // WAL keeps readers from blocking the writer, which matters because the
        // capture ingester writes while the cache browser reads.
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        return db;
      }
    };
  } catch (e) {
    log.error('The SQLite module could not be loaded; the asset index is unavailable', {
      reason: e instanceof Error ? e.message : String(e)
    });
    return null;
  }
}

/**
 * Schema migrations, applied in order. `user_version` records how far a
 * database has come, so an existing index is upgraded rather than rebuilt.
 */
export const MIGRATIONS: string[] = [
  // 1 — assets, rule sets, rules, capture sessions
  `
  CREATE TABLE IF NOT EXISTS assets (
    asset_id     TEXT PRIMARY KEY,
    asset_type   TEXT NOT NULL,
    source_url   TEXT,
    hash         TEXT,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    hit_count    INTEGER NOT NULL DEFAULT 1,
    origin       TEXT NOT NULL DEFAULT 'proxy',
    meta         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_assets_last_seen ON assets(last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_type      ON assets(asset_type, last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_size      ON assets(size_bytes DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_hash      ON assets(hash);

  CREATE TABLE IF NOT EXISTS rule_sets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rules (
    id         TEXT PRIMARY KEY,
    set_id     TEXT NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    asset_type TEXT NOT NULL DEFAULT 'unknown',
    enabled    INTEGER NOT NULL DEFAULT 1,
    priority   INTEGER NOT NULL DEFAULT 0,
    notes      TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_rules_set    ON rules(set_id, priority DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);

  CREATE TABLE IF NOT EXISTS blobs (
    hash       TEXT PRIMARY KEY,
    size_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL,
    refs       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_blobs_last_used ON blobs(last_used);

  CREATE TABLE IF NOT EXISTS capture_sessions (
    id         TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER,
    events     INTEGER NOT NULL DEFAULT 0,
    dropped    INTEGER NOT NULL DEFAULT 0,
    source     TEXT NOT NULL
  );
  `
];

export function applyMigrations(db: Database, log: ScopedLogger): void {
  const row = db.pragma('user_version') as { user_version?: number }[] | number;
  const current = Array.isArray(row) ? row[0]?.user_version ?? 0 : Number(row) || 0;

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (!sql) continue;
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
      db.exec('COMMIT');
      log.info('Asset index upgraded', { to: version + 1 });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
