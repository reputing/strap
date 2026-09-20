import type { FlagPrefix, FlagValueType } from '@shared/types';

/**
 * Roblox flag names are `<prefix><Name>`. The prefix determines the value type,
 * which is what lets Blossom validate a value before it is ever written to a
 * file Roblox reads.
 *
 *   F / FF  static, baked into the client build
 *   DF      dynamic, fetched at runtime
 *   SF      synchronised
 */
const PREFIXES: { prefix: FlagPrefix; type: FlagValueType }[] = [
  { prefix: 'DFFlag', type: 'bool' },
  { prefix: 'SFFlag', type: 'bool' },
  { prefix: 'FFlag', type: 'bool' },
  { prefix: 'DFInt', type: 'int' },
  { prefix: 'SFInt', type: 'int' },
  { prefix: 'FInt', type: 'int' },
  { prefix: 'DFString', type: 'string' },
  { prefix: 'SFString', type: 'string' },
  { prefix: 'FString', type: 'string' },
  { prefix: 'DFLog', type: 'int' },
  { prefix: 'FLog', type: 'int' }
];

export interface ParsedFlag {
  prefix: FlagPrefix;
  /** The part after the prefix, e.g. "TaskSchedulerTargetFps". */
  body: string;
  valueType: FlagValueType;
}

/** Splits a flag name into prefix and body, or null when the prefix is unknown. */
export function parseFlagName(name: string): ParsedFlag | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  // Longest prefixes are tested first so FFlag does not swallow FFlagDebug…
  // incorrectly and DFFlag is never read as FFlag.
  for (const { prefix, type } of [...PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length)) {
    if (trimmed.startsWith(prefix) && trimmed.length > prefix.length) {
      return { prefix, body: trimmed.slice(prefix.length), valueType: type };
    }
  }
  return null;
}

export function valueTypeFor(name: string): FlagValueType {
  return parseFlagName(name)?.valueType ?? 'unknown';
}

/**
 * Checks a value against the type its prefix implies. Roblox reads every value
 * out of ClientAppSettings.json as a string, so the canonical storage form is a
 * string — but a boolean flag set to "yes" is a mistake worth catching.
 */
export function checkValue(name: string, value: string): { ok: true } | { ok: false; message: string } {
  const parsed = parseFlagName(name);
  if (!parsed) {
    return { ok: false, message: 'Unknown prefix. Flag names start with FFlag, DFInt, FString and similar.' };
  }
  if (typeof value !== 'string') {
    return { ok: false, message: 'Values are stored as text.' };
  }

  switch (parsed.valueType) {
    case 'bool':
      return /^(true|false)$/i.test(value.trim())
        ? { ok: true }
        : { ok: false, message: 'This flag takes True or False.' };
    case 'int': {
      const trimmed = value.trim();
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, message: 'This flag takes a whole number.' };
      const n = Number(trimmed);
      if (!Number.isSafeInteger(n)) return { ok: false, message: 'That number is too large for Roblox to read.' };
      return { ok: true };
    }
    case 'string':
      return value.length <= 4096
        ? { ok: true }
        : { ok: false, message: 'That value is too long.' };
    default:
      return { ok: true };
  }
}

/** Normalises a value into the form Roblox expects, e.g. "TRUE" → "True". */
export function normaliseValue(name: string, value: string): string {
  const type = valueTypeFor(name);
  const trimmed = String(value).trim();
  if (type === 'bool') {
    if (/^true$/i.test(trimmed)) return 'True';
    if (/^false$/i.test(trimmed)) return 'False';
  }
  if (type === 'int') {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return String(Math.trunc(n));
  }
  return trimmed;
}

/** A flag name is well-formed if it parses and contains no odd characters. */
export function isValidFlagName(name: string): boolean {
  return parseFlagName(name) !== null && /^[A-Za-z][A-Za-z0-9_]*$/.test(name.trim());
}
