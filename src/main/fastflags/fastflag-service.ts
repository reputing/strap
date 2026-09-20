import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import type { FlagDefinition, FlagDiffRow, FlagValidationIssue, RobloxInstallation } from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import { ensureDir, exists, writeFileAtomic } from '@main/core/fs-utils';
import { FLAG_CATALOG, MUTUALLY_EXCLUSIVE, findFlag } from './catalog';
import { checkValue, isValidFlagName, normaliseValue, parseFlagName } from './flag-syntax';

export const CLIENT_SETTINGS_DIR = 'ClientSettings';
export const CLIENT_SETTINGS_FILE = 'ClientAppSettings.json';

/**
 * Reads and writes Roblox's local flag override file.
 *
 * Roblox deletes the `ClientSettings` folder on every client update, which is
 * why overrides are owned by a Blossom profile and re-applied at launch rather
 * than written once and forgotten.
 */
export class FastFlagService {
  constructor(private readonly log: ScopedLogger) {}

  static settingsPath(install: RobloxInstallation): string {
    return join(install.directory, CLIENT_SETTINGS_DIR, CLIENT_SETTINGS_FILE);
  }

  catalog(): FlagDefinition[] {
    return FLAG_CATALOG;
  }

  /**
   * Validates a flag set. Returns issues rather than throwing so the editor can
   * show every problem at once instead of stopping at the first.
   */
  validate(flags: Record<string, string>): FlagValidationIssue[] {
    const issues: FlagValidationIssue[] = [];

    for (const [name, value] of Object.entries(flags ?? {})) {
      if (!isValidFlagName(name)) {
        issues.push({
          name,
          severity: 'error',
          message: parseFlagName(name)
            ? 'Flag names may only contain letters, numbers and underscores.'
            : 'Unrecognised prefix. Names start with FFlag, DFFlag, FInt, DFInt, FString or similar.'
        });
        continue;
      }

      const check = checkValue(name, value);
      if (!check.ok) {
        issues.push({ name, severity: 'error', message: check.message });
        continue;
      }

      const def = findFlag(name);
      if (!def) {
        issues.push({
          name,
          severity: 'warning',
          message: 'Blossom does not recognise this flag. The syntax is valid; the behaviour is unknown.'
        });
      } else if (def.deprecatedNote) {
        issues.push({ name, severity: 'warning', message: def.deprecatedNote });
      } else if (def.risk === 'advanced') {
        issues.push({
          name,
          severity: 'warning',
          message: 'This flag is marked advanced. A wrong value can make the client unusable.'
        });
      }
    }

    // Cross-flag rules.
    for (const rule of MUTUALLY_EXCLUSIVE) {
      const enabled = rule.flags.filter((f) => /^true$/i.test(flags[f] ?? ''));
      if (enabled.length > 1) {
        for (const name of enabled) {
          issues.push({ name, severity: 'error', message: rule.reason });
        }
      }
    }

    const min = Number(flags['FIntRenderLocalLightUpdatesMin']);
    const max = Number(flags['FIntRenderLocalLightUpdatesMax']);
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
      issues.push({
        name: 'FIntRenderLocalLightUpdatesMin',
        severity: 'error',
        message: 'The minimum local light updates value must not exceed the maximum.'
      });
    }

    return issues;
  }

  /** Normalises every value into the exact form Roblox expects. */
  normalise(flags: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(flags ?? {})) {
      const key = name.trim();
      if (!key) continue;
      out[key] = normaliseValue(key, String(value));
    }
    return out;
  }

  /**
   * Builds the "Roblox default vs Blossom override" view. Where Roblox's own
   * default is not publicly known the row says so rather than guessing.
   */
  diff(flags: Record<string, string>, applied: Record<string, string> = {}): FlagDiffRow[] {
    const names = new Set([...Object.keys(flags ?? {}), ...Object.keys(applied ?? {})]);
    const rows: FlagDiffRow[] = [];

    for (const name of names) {
      const def = findFlag(name);
      const blossomValue = flags[name] ?? null;
      const appliedValue = applied[name] ?? null;
      const robloxDefault = def?.robloxDefault ?? null;

      let kind: FlagDiffRow['kind'];
      if (blossomValue === null) kind = 'removed';
      else if (appliedValue === null) kind = 'added';
      else if (appliedValue !== blossomValue) kind = 'changed';
      else if (robloxDefault !== null && robloxDefault === blossomValue) kind = 'unchanged';
      else kind = 'unchanged';

      rows.push({ name, kind, robloxDefault, blossomValue, definition: def });
    }

    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reads the override file Roblox is currently going to load. */
  async readApplied(install: RobloxInstallation): Promise<Record<string, string>> {
    const path = FastFlagService.settingsPath(install);
    try {
      const raw = await fs.readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = typeof v === 'string' ? v : String(v);
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Writes the override file. The caller is responsible for having taken a
   * restore point first; `LauncherService` always does.
   */
  async apply(install: RobloxInstallation, flags: Record<string, string>): Promise<Result<{ path: string; flagCount: number }>> {
    const issues = this.validate(flags).filter((i) => i.severity === 'error');
    if (issues.length) {
      return Err('validation-failed', `${issues.length} flag ${issues.length === 1 ? 'value is' : 'values are'} not valid.`, {
        remediation: 'Fix the highlighted flags in the FastFlags editor and try again.',
        details: { issues: issues.slice(0, 5) }
      });
    }

    const path = FastFlagService.settingsPath(install);
    const normalised = this.normalise(flags);

    try {
      await ensureDir(join(install.directory, CLIENT_SETTINGS_DIR));
      if (Object.keys(normalised).length === 0) {
        // No overrides means no file, not an empty object: an empty file is
        // still Blossom asserting control over something it is not changing.
        await fs.rm(path, { force: true });
        this.log.info('Cleared FastFlag overrides', { version: install.versionGuid });
        return Ok({ path, flagCount: 0 });
      }

      await writeFileAtomic(path, JSON.stringify(normalised, null, 2) + '\n');
      this.log.info('FastFlag overrides written', {
        version: install.versionGuid,
        count: Object.keys(normalised).length
      });
      return Ok({ path, flagCount: Object.keys(normalised).length });
    } catch (e) {
      return Err('io-failure', 'Blossom could not write the FastFlag overrides.', {
        remediation: 'Close Roblox and try again. If it persists, check that antivirus is not locking the Roblox folder.',
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /** Removes Blossom's override file, returning Roblox to its own defaults. */
  async clear(install: RobloxInstallation): Promise<Result<void>> {
    const path = FastFlagService.settingsPath(install);
    try {
      if (await exists(path)) {
        await fs.rm(path, { force: true });
        this.log.info('FastFlag overrides removed', { version: install.versionGuid });
      }
      return Ok(undefined);
    } catch (e) {
      return Err('io-failure', 'Blossom could not remove the FastFlag overrides.', {
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /**
   * Parses a pasted or imported JSON flag document. Accepts the format every
   * other launcher uses — a flat object — and coerces non-string values rather
   * than rejecting the file.
   */
  parseImport(json: string): Result<Record<string, string>> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return Err('parse-failure', 'That is not valid JSON.', {
        remediation: 'Paste a flat object such as { "DFIntTaskSchedulerTargetFps": "144" }.'
      });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Err('parse-failure', 'A FastFlag file is a JSON object of flag names to values.');
    }

    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v === 'object') continue;
      out[k.trim()] = normaliseValue(k.trim(), String(v));
    }
    return Ok(out);
  }
}
