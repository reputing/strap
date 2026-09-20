import { EventEmitter } from 'node:events';
import type { AppSettings } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from './paths';
import { readJsonSafe, writeJsonAtomic } from './fs-utils';
import { defaultSettings, SETTINGS_SCHEMA_VERSION } from './defaults';
import type { ScopedLogger } from './logger';

/**
 * Application settings. Distinct from profiles: settings describe how Blossom
 * behaves, profiles describe how Roblox is launched and modified.
 *
 * Writes are atomic, coalesced (a burst of UI edits is one disk write) and
 * never throw — a failed write is logged and reported, but the in-memory value
 * stays authoritative so the UI does not desynchronise.
 */
export class ConfigService extends EventEmitter {
  private settings: AppSettings = defaultSettings();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly paths: BlossomPaths,
    private readonly log: ScopedLogger
  ) {
    super();
  }

  async load(): Promise<AppSettings> {
    const raw = await readJsonSafe<Partial<AppSettings>>(
      this.paths.config,
      {},
      (movedTo, reason) => this.log.warn('Settings file was unreadable and has been reset', { movedTo, reason })
    );
    this.settings = migrate(raw);
    this.log.info('Settings loaded', { profile: this.settings.activeProfileId, level: this.settings.logLevel });
    return this.settings;
  }

  get(): AppSettings {
    return this.settings;
  }

  /** Shallow-merges a patch, deep-merging the known nested objects. */
  update(patch: Partial<AppSettings>): AppSettings {
    const prev = this.settings;
    this.settings = {
      ...prev,
      ...patch,
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appearance: { ...prev.appearance, ...patch.appearance },
      updates: { ...prev.updates, ...patch.updates },
      interception: { ...prev.interception, ...patch.interception },
      hotkeys: {
        ...prev.hotkeys,
        ...patch.hotkeys,
        bindings: { ...prev.hotkeys.bindings, ...patch.hotkeys?.bindings }
      },
      diagnostics: { ...prev.diagnostics, ...patch.diagnostics }
    };
    this.scheduleFlush();
    this.emit('changed', this.settings);
    return this.settings;
  }

  reset(): AppSettings {
    this.settings = defaultSettings();
    this.scheduleFlush();
    this.emit('changed', this.settings);
    return this.settings;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { void this.flush(); }, 250);
    // A pending settings write must not hold the process open at shutdown.
    this.flushTimer.unref?.();
  }

  async flush(): Promise<Result<void>> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Serialise concurrent flushes so two writers cannot interleave.
    while (this.flushing) await this.flushing;
    const snapshot = this.settings;
    let done: () => void = () => {};
    this.flushing = new Promise<void>((r) => { done = r; });
    try {
      await writeJsonAtomic(this.paths.config, snapshot);
      return Ok(undefined);
    } catch (e) {
      this.log.error('Could not save settings', { reason: e instanceof Error ? e.message : String(e) });
      return Err('io-failure', 'Blossom could not save its settings.', {
        remediation: 'Check that the Blossom Strap folder is writable and not blocked by antivirus.'
      });
    } finally {
      this.flushing = null;
      done();
    }
  }
}

/** Fills in anything missing and brings older files forward. */
export function migrate(raw: Partial<AppSettings>): AppSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;

  const merged: AppSettings = {
    ...base,
    ...raw,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    appearance: { ...base.appearance, ...raw.appearance },
    updates: { ...base.updates, ...raw.updates },
    interception: {
      ...base.interception,
      ...raw.interception,
      // Scope is replaced wholesale rather than merged, but an empty or
      // non-array scope falls back to the safe default list.
      scope: Array.isArray(raw.interception?.scope) && raw.interception.scope.length
        ? raw.interception.scope.filter((s) => typeof s === 'string')
        : base.interception.scope
    },
    hotkeys: {
      ...base.hotkeys,
      ...raw.hotkeys,
      bindings: { ...base.hotkeys.bindings, ...raw.hotkeys?.bindings }
    },
    diagnostics: { ...base.diagnostics, ...raw.diagnostics }
  };

  // Clamp anything that would be nonsensical rather than rejecting the file.
  merged.interception.port = clampInt(merged.interception.port, 0, 65535, 0);
  merged.interception.cacheBudgetBytes = clampInt(
    merged.interception.cacheBudgetBytes,
    64 * 1024 * 1024,
    512 * 1024 * 1024 * 1024,
    base.interception.cacheBudgetBytes
  );
  if (typeof merged.activeProfileId !== 'string' || !merged.activeProfileId) {
    merged.activeProfileId = base.activeProfileId;
  }
  return merged;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}
