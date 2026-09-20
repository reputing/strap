import type { Profile, ValidationIssue, ValidationReport } from '@shared/types';
import { PROFILE_SCHEMA_VERSION } from '@shared/types';
import { emptyProfile } from '@main/core/defaults';
import { checkValue, isValidFlagName } from '@main/fastflags/flag-syntax';
import { findFlag } from '@main/fastflags/catalog';

const PRESETS = new Set(['conservative', 'balanced', 'performance', 'low-end', 'custom']);
const PRIORITIES = new Set(['normal', 'above-normal', 'high']);
const ACCENTS = new Set(['blossom', 'violet', 'rose', 'mint', 'amber']);
const CROSSHAIR_STYLES = new Set(['cross', 'dot', 'cross-dot', 'circle', 't-shape']);
const CORNERS = new Set(['top-left', 'top-right', 'bottom-left', 'bottom-right']);

/**
 * Coerces arbitrary parsed JSON into a valid Profile.
 *
 * Nothing here throws. A profile from an older Blossom, a hand-edited file or a
 * stranger's export is brought into shape field by field, and anything that
 * cannot be understood falls back to the default for that field. The companion
 * `validateProfile` reports what was wrong so the UI can tell the user.
 */
export function coerceProfile(raw: unknown, fallbackId = 'imported'): Profile {
  const base = emptyProfile(fallbackId, 'Imported profile');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;

  const id = str(r['id']) || fallbackId;
  const out = emptyProfile(id, str(r['name']) || 'Imported profile');

  out.description = str(r['description']);
  out.builtIn = false; // An imported profile is never built in.
  out.createdAt = num(r['createdAt'], out.createdAt);
  out.updatedAt = num(r['updatedAt'], Date.now());

  const launcher = obj(r['launcher']);
  out.launcher = {
    kind: launcher['kind'] === 'studio' ? 'studio' : 'player',
    multiInstance: bool(launcher['multiInstance'], false),
    priority: PRIORITIES.has(str(launcher['priority'])) ? (str(launcher['priority']) as Profile['launcher']['priority']) : 'normal',
    affinityMask: intOrNull(launcher['affinityMask']),
    extraArgs: strArray(launcher['extraArgs']).slice(0, 32),
    onExit: ['restore', 'keep', 'quit-blossom'].includes(str(launcher['onExit']))
      ? (str(launcher['onExit']) as Profile['launcher']['onExit'])
      : 'restore',
    hideOnLaunch: bool(launcher['hideOnLaunch'], true)
  };

  const flags = obj(r['fastFlags']);
  const cleanFlags: Record<string, string> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (v === null || typeof v === 'object') continue;
    const key = k.trim();
    if (key) cleanFlags[key] = String(v);
  }
  out.fastFlags = cleanFlags;

  const optimizer = obj(r['optimizer']);
  out.optimizer = {
    preset: PRESETS.has(str(optimizer['preset'])) ? (str(optimizer['preset']) as Profile['optimizer']['preset']) : 'balanced',
    overrides: boolMap(optimizer['overrides'])
  };

  const assets = obj(r['assets']);
  out.assets = {
    interception: bool(assets['interception'], false),
    assetProfileIds: strArray(assets['assetProfileIds']).slice(0, 64),
    capture: bool(assets['capture'], false)
  };

  const overlay = obj(r['overlay']);
  const crosshair = obj(overlay['crosshair']);
  const hud = obj(overlay['hud']);
  out.overlay = {
    crosshair: {
      enabled: bool(crosshair['enabled'], false),
      style: CROSSHAIR_STYLES.has(str(crosshair['style'])) ? (str(crosshair['style']) as Profile['overlay']['crosshair']['style']) : 'cross-dot',
      size: clamp(num(crosshair['size'], 12), 1, 200),
      thickness: clamp(num(crosshair['thickness'], 2), 1, 20),
      gap: clamp(num(crosshair['gap'], 4), 0, 80),
      color: colour(crosshair['color'], '#ff5fa2'),
      opacity: clamp(num(crosshair['opacity'], 0.9), 0.05, 1),
      outline: bool(crosshair['outline'], true),
      outlineColor: colour(crosshair['outlineColor'], '#000000'),
      offsetX: clamp(num(crosshair['offsetX'], 0), -2000, 2000),
      offsetY: clamp(num(crosshair['offsetY'], 0), -2000, 2000)
    },
    hud: {
      enabled: bool(hud['enabled'], false),
      corner: CORNERS.has(str(hud['corner'])) ? (str(hud['corner']) as Profile['overlay']['hud']['corner']) : 'top-left',
      showFps: bool(hud['showFps'], true),
      showCpu: bool(hud['showCpu'], true),
      showMemory: bool(hud['showMemory'], true),
      showUptime: bool(hud['showUptime'], true),
      showPing: bool(hud['showPing'], false),
      opacity: clamp(num(hud['opacity'], 0.85), 0.05, 1),
      scale: clamp(num(hud['scale'], 1), 0.5, 3)
    }
  };

  const appearance = obj(r['appearance']);
  out.appearance = {
    accent: ACCENTS.has(str(appearance['accent'])) ? (str(appearance['accent']) as Profile['appearance']['accent']) : 'blossom',
    density: str(appearance['density']) === 'compact' ? 'compact' : 'comfortable',
    reduceMotion: bool(appearance['reduceMotion'], false)
  };

  return out;
}

/**
 * Reports everything questionable about a profile. A profile with only warnings
 * is usable; one with errors can be edited but not launched with.
 */
export function validateProfile(profile: Profile): ValidationReport {
  const issues: ValidationIssue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  if (!profile.id || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(profile.id)) {
    err('id', 'A profile id must be 1–64 letters, numbers or hyphens.');
  }
  if (!profile.name.trim()) err('name', 'A profile needs a name.');
  if (profile.name.length > 64) err('name', 'Profile names are limited to 64 characters.');

  if (profile.schemaVersion > PROFILE_SCHEMA_VERSION) {
    err('schemaVersion', `This profile was written by a newer version of Blossom Strap (format ${profile.schemaVersion}).`);
  }

  for (const [name, value] of Object.entries(profile.fastFlags)) {
    if (!isValidFlagName(name)) {
      err(`fastFlags.${name}`, 'This is not a valid FastFlag name.');
      continue;
    }
    const check = checkValue(name, value);
    if (!check.ok) {
      err(`fastFlags.${name}`, check.message);
      continue;
    }
    const def = findFlag(name);
    if (!def) warn(`fastFlags.${name}`, 'Blossom does not recognise this flag; its effect is unknown.');
    else if (def.risk === 'advanced') warn(`fastFlags.${name}`, 'This flag is marked advanced.');
  }

  for (const arg of profile.launcher.extraArgs) {
    if (arg.length > 512) err('launcher.extraArgs', 'A launch argument is unreasonably long.');
    if (/[\r\n\0]/.test(arg)) err('launcher.extraArgs', 'Launch arguments cannot contain line breaks.');
  }

  if (profile.launcher.affinityMask !== null && profile.launcher.affinityMask <= 0) {
    err('launcher.affinityMask', 'A CPU affinity mask must select at least one core.');
  }

  if (profile.launcher.kind === 'studio' && profile.assets.interception) {
    warn('assets.interception', 'Asset interception applies to Roblox Player. Studio is not intercepted.');
  }

  if (profile.assets.interception && profile.assets.assetProfileIds.length === 0) {
    warn('assets.assetProfileIds', 'Interception is on but no asset rule sets are selected, so nothing will be replaced.');
  }

  if (profile.launcher.priority === 'high') {
    warn('launcher.priority', 'High priority can make the rest of the system feel sluggish. Above normal is usually enough.');
  }

  return { valid: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * Brings a stored profile forward to the current schema version.
 *
 * Migrations are a chain of pure functions, one per version step, so an export
 * from any earlier Blossom keeps loading no matter how many versions pass.
 */
type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  // 0 → 1: the earliest development builds had no schemaVersion and stored
  // launcher settings at the top level.
  0: (raw) => {
    const out: Record<string, unknown> = { ...raw, schemaVersion: 1 };
    if (!out['launcher'] && (out['multiInstance'] !== undefined || out['priority'] !== undefined)) {
      out['launcher'] = {
        kind: out['kind'] ?? 'player',
        multiInstance: out['multiInstance'],
        priority: out['priority'],
        extraArgs: out['extraArgs']
      };
    }
    return out;
  }
};

export function migrateProfile(raw: unknown): { raw: Record<string, unknown>; migratedFrom: number | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { raw: {}, migratedFrom: null };
  }
  let current = raw as Record<string, unknown>;
  const startVersion = Number(current['schemaVersion']) || 0;
  let version = startVersion;

  while (version < PROFILE_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) break;
    current = migrate(current);
    const next = Number(current['schemaVersion']) || version + 1;
    if (next <= version) break; // A migration that does not advance would loop.
    version = next;
  }

  return { raw: current, migratedFrom: version !== startVersion ? startVersion : null };
}

// ── coercion helpers ────────────────────────────────────────────────────
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function intOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function boolMap(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(obj(v))) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
}
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
function colour(v: unknown, fallback: string): string {
  const s = str(v).trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s : fallback;
}
