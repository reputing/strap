import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { Profile, ValidationReport } from '@shared/types';
import { PROFILE_SCHEMA_VERSION } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { BlossomPaths } from '@main/core/paths';
import type { ScopedLogger } from '@main/core/logger';
import { builtInProfiles, emptyProfile } from '@main/core/defaults';
import { ensureDir, readJsonSafe, writeJsonAtomic } from '@main/core/fs-utils';
import { coerceProfile, migrateProfile, validateProfile } from './schema';

/**
 * Profiles: the unit Blossom applies. One profile carries the launcher
 * configuration, flag overrides, optimizer selection, asset rule sets and
 * overlay settings that go together.
 *
 * Built-in profiles cannot be deleted or edited in place; editing one produces
 * a copy, so the user always has a known-good starting point to come back to.
 */
export class ProfileService extends EventEmitter {
  private readonly profiles = new Map<string, Profile>();
  private activeId = 'default';

  constructor(
    private readonly paths: BlossomPaths,
    private readonly log: ScopedLogger
  ) {
    super();
  }

  async load(activeId: string): Promise<void> {
    await ensureDir(this.paths.profiles);

    for (const p of builtInProfiles()) this.profiles.set(p.id, p);

    let files: string[] = [];
    try {
      files = (await fs.readdir(this.paths.profiles)).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }

    for (const file of files) {
      const path = join(this.paths.profiles, file);
      const raw = await readJsonSafe<unknown>(path, null, (movedTo) =>
        this.log.warn('A profile file was unreadable and has been set aside', { file, movedTo })
      );
      if (!raw) continue;

      const { raw: migrated, migratedFrom } = migrateProfile(raw);
      const profile = coerceProfile(migrated, file.replace(/\.json$/, ''));
      profile.builtIn = false;

      if (migratedFrom !== null) {
        this.log.info('Profile migrated to the current format', {
          profile: profile.id, from: migratedFrom, to: PROFILE_SCHEMA_VERSION
        });
        await writeJsonAtomic(path, profile).catch(() => undefined);
      }

      const report = validateProfile(profile);
      if (!report.valid) {
        this.log.warn('Profile has problems and cannot be launched with until they are fixed', {
          profile: profile.id,
          errors: report.issues.filter((i) => i.severity === 'error').length
        });
      }
      this.profiles.set(profile.id, profile);
    }

    this.activeId = this.profiles.has(activeId) ? activeId : 'default';
    this.log.info('Profiles loaded', { count: this.profiles.size, active: this.activeId });
  }

  list(): Profile[] {
    return [...this.profiles.values()].sort((a, b) => {
      if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  get(id: string): Result<Profile> {
    const p = this.profiles.get(id);
    return p ? Ok(p) : Err('not-found', 'That profile no longer exists.');
  }

  active(): Profile {
    // There is always a `default` built-in, so this cannot legitimately fail.
    return this.profiles.get(this.activeId) ?? this.profiles.get('default') ?? emptyProfile('default', 'Default');
  }

  activeIdValue(): string {
    return this.activeId;
  }

  setActive(id: string): Result<Profile> {
    const p = this.profiles.get(id);
    if (!p) return Err('not-found', 'That profile no longer exists.');
    this.activeId = id;
    this.log.info('Profile activated', { profile: p.name });
    this.emit('changed', this.list());
    this.emit('activated', p);
    return Ok(p);
  }

  validate(id: string): Result<ValidationReport> {
    const p = this.profiles.get(id);
    return p ? Ok(validateProfile(p)) : Err('not-found', 'That profile no longer exists.');
  }

  async create(name: string, from?: string): Promise<Result<Profile>> {
    const trimmed = name.trim();
    if (!trimmed) return Err('invalid-argument', 'A profile needs a name.');
    if (trimmed.length > 64) return Err('invalid-argument', 'Profile names are limited to 64 characters.');

    const id = await this.uniqueId(trimmed);
    const source = from ? this.profiles.get(from) : null;
    const profile: Profile = source
      ? { ...structuredClone(source), id, name: trimmed, builtIn: false, createdAt: Date.now(), updatedAt: Date.now() }
      : { ...emptyProfile(id, trimmed) };

    this.profiles.set(id, profile);
    const saved = await this.save(profile);
    if (!saved.ok) {
      this.profiles.delete(id);
      return saved;
    }
    this.log.info('Profile created', { profile: trimmed, from: from ?? 'blank' });
    this.emit('changed', this.list());
    return Ok(profile);
  }

  /**
   * Applies a patch. Editing a built-in profile forks it rather than changing
   * it, so the shipped presets always stay available.
   */
  async update(id: string, patch: Partial<Profile>): Promise<Result<Profile>> {
    const existing = this.profiles.get(id);
    if (!existing) return Err('not-found', 'That profile no longer exists.');

    if (existing.builtIn) {
      const forked = await this.create(patch.name?.trim() || `${existing.name} (edited)`, id);
      if (!forked.ok) return forked;
      const applied = await this.update(forked.value.id, { ...patch, name: forked.value.name });
      if (applied.ok) this.setActive(applied.value.id);
      return applied;
    }

    const merged = coerceProfile(
      {
        ...existing,
        ...patch,
        id: existing.id,
        builtIn: false,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        launcher: { ...existing.launcher, ...patch.launcher },
        optimizer: { ...existing.optimizer, ...patch.optimizer },
        assets: { ...existing.assets, ...patch.assets },
        appearance: { ...existing.appearance, ...patch.appearance },
        overlay: patch.overlay
          ? {
            crosshair: { ...existing.overlay.crosshair, ...patch.overlay.crosshair },
            hud: { ...existing.overlay.hud, ...patch.overlay.hud }
          }
          : existing.overlay,
        fastFlags: patch.fastFlags ?? existing.fastFlags
      },
      existing.id
    );

    this.profiles.set(id, merged);
    const saved = await this.save(merged);
    if (!saved.ok) {
      this.profiles.set(id, existing); // Roll the in-memory copy back.
      return saved;
    }
    this.emit('changed', this.list());
    if (id === this.activeId) this.emit('activated', merged);
    return Ok(merged);
  }

  async delete(id: string): Promise<Result<void>> {
    const existing = this.profiles.get(id);
    if (!existing) return Err('not-found', 'That profile no longer exists.');
    if (existing.builtIn) {
      return Err('invalid-argument', 'Built-in profiles cannot be deleted.', {
        remediation: 'Duplicate it first if you want a version you can change or remove.'
      });
    }

    this.profiles.delete(id);
    await fs.rm(join(this.paths.profiles, `${id}.json`), { force: true }).catch(() => undefined);

    if (this.activeId === id) this.activeId = 'default';
    this.log.info('Profile deleted', { profile: existing.name });
    this.emit('changed', this.list());
    return Ok(undefined);
  }

  async duplicate(id: string, name: string): Promise<Result<Profile>> {
    return this.create(name, id);
  }

  /** Serialises a profile for export. Ids are kept so re-import can detect collisions. */
  exportJson(id: string): Result<string> {
    const p = this.profiles.get(id);
    if (!p) return Err('not-found', 'That profile no longer exists.');
    return Ok(JSON.stringify({ ...p, builtIn: false }, null, 2) + '\n');
  }

  /**
   * Imports a profile from JSON. Never throws on bad input: the document is
   * coerced, validated, given a fresh id if it collides, and the report is
   * handed back so the UI can show what was adjusted.
   */
  async importJson(json: string): Promise<Result<{ profile: Profile; report: ValidationReport }>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return Err('parse-failure', 'That file is not valid JSON.', {
        remediation: 'Export a profile from Blossom Strap to see the expected shape.'
      });
    }

    const { raw, migratedFrom } = migrateProfile(parsed);
    const candidate = coerceProfile(raw, 'imported');

    if (!candidate.name.trim()) candidate.name = 'Imported profile';
    if (this.profiles.has(candidate.id) || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(candidate.id)) {
      candidate.id = await this.uniqueId(candidate.name);
    }
    candidate.builtIn = false;
    candidate.updatedAt = Date.now();

    const report = validateProfile(candidate);
    this.profiles.set(candidate.id, candidate);
    const saved = await this.save(candidate);
    if (!saved.ok) {
      this.profiles.delete(candidate.id);
      return saved;
    }

    this.log.info('Profile imported', {
      profile: candidate.name,
      migratedFrom: migratedFrom ?? 'current',
      issues: report.issues.length
    });
    this.emit('changed', this.list());
    return Ok({ profile: candidate, report });
  }

  private async save(profile: Profile): Promise<Result<void>> {
    if (profile.builtIn) return Ok(undefined); // Built-ins live in code, not on disk.
    try {
      await ensureDir(this.paths.profiles);
      await writeJsonAtomic(join(this.paths.profiles, `${profile.id}.json`), profile);
      return Ok(undefined);
    } catch (e) {
      this.log.error('Could not save a profile', {
        profile: profile.id,
        reason: e instanceof Error ? e.message : String(e)
      });
      return Err('io-failure', 'Blossom could not save that profile.', {
        remediation: 'Check that the Blossom Strap folder is writable.'
      });
    }
  }

  private async uniqueId(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile';
    if (!this.profiles.has(base)) return base;
    for (let i = 2; i < 500; i++) {
      const candidate = `${base}-${i}`;
      if (!this.profiles.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}
