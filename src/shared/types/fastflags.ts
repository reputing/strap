export type FlagValueType = 'bool' | 'int' | 'string' | 'unknown';

/**
 * Roblox flag prefixes. The prefix determines the value type and whether the
 * flag can be overridden locally at all.
 */
export type FlagPrefix =
  | 'FFlag' | 'DFFlag' | 'SFFlag'
  | 'FInt' | 'DFInt' | 'SFInt'
  | 'FString' | 'DFString' | 'SFString'
  | 'FLog' | 'DFLog';

export interface FlagDefinition {
  /** Full flag name including prefix, e.g. "DFIntTaskSchedulerTargetFps". */
  name: string;
  prefix: FlagPrefix;
  valueType: FlagValueType;
  category: 'rendering' | 'performance' | 'network' | 'ui' | 'audio' | 'input' | 'debug' | 'other';
  /** What the flag does. Absent for flags we know exist but cannot describe. */
  description: string;
  /** Roblox's own default, when it is publicly known. Null otherwise. */
  robloxDefault: string | null;
  /** Documented, widely used flags are 'known'; the rest are user-supplied. */
  confidence: 'documented' | 'community' | 'unverified';
  risk: 'safe' | 'low' | 'moderate' | 'advanced';
  /** Set when the flag is known to be removed or ignored by recent clients. */
  deprecatedNote?: string;
  /** Example or allowed values, for the editor. */
  suggestions?: string[];
}

export interface FlagEntry {
  name: string;
  value: string;
  enabled: boolean;
  definition: FlagDefinition | null;
}

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FlagDiffRow {
  name: string;
  kind: DiffKind;
  robloxDefault: string | null;
  blossomValue: string | null;
  definition: FlagDefinition | null;
}

export interface FlagValidationIssue {
  name: string;
  severity: 'error' | 'warning';
  message: string;
}
