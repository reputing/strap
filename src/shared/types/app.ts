import type { AppearanceConfig } from './profile';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogRecord {
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

export type UpdateChannel = 'stable' | 'preview';

export interface AppSettings {
  schemaVersion: number;
  activeProfileId: string;
  appearance: AppearanceConfig;
  /** Blossom handles roblox-player:// links. Opt-in; reversible. */
  registerProtocolHandler: boolean;
  startWithWindows: boolean;
  startMinimised: boolean;
  closeToTray: boolean;
  confirmBeforeLaunch: boolean;
  logLevel: LogLevel;
  updates: {
    channel: UpdateChannel;
    checkAutomatically: boolean;
    lastCheckedAt: number | null;
  };
  interception: {
    /** Global kill switch; a profile can only enable interception if this is true. */
    enabled: boolean;
    /** Preferred loopback port; 0 picks an ephemeral one. */
    port: number;
    /** Host suffixes the proxy is allowed to decrypt. */
    scope: string[];
    /** Keep captured bytes on disk. */
    cacheResponses: boolean;
    /** Byte budget for the blob store; oldest-unused blobs are evicted past it. */
    cacheBudgetBytes: number;
  };
  hotkeys: {
    /** Global hotkeys are off until the user turns them on, one by one. */
    enabled: boolean;
    bindings: Record<HotkeyAction, string>;
  };
  diagnostics: {
    /** Include the machine's hardware summary in generated reports. */
    includeHardware: boolean;
  };
}

export type HotkeyAction =
  | 'show-window'
  | 'quick-launch'
  | 'toggle-interception'
  | 'toggle-capture'
  | 'toggle-crosshair'
  | 'toggle-hud';

export interface DiagnosticsReport {
  generatedAt: number;
  blossom: { version: string; channel: UpdateChannel; electron: string; node: string; chrome: string };
  system: { os: string; version: string; arch: string; memoryBytes: number; cpu: string };
  hardwareIncluded: boolean;
  roblox: {
    installations: { kind: string; version: string | null; guid: string; path: string }[];
    active: string | null;
    running: number;
    latestKnown: string | null;
  };
  profile: { id: string; name: string; valid: boolean; issues: number } | null;
  modifications: {
    fastFlagCount: number;
    optimizerPreset: string;
    appliedActions: number;
    modFileCount: number;
    assetRuleCount: number;
  };
  interception: { status: string; port: number | null; certificateInstalled: boolean };
  cache: { assets: number; bytes: number };
  recentErrors: { at: number; scope: string; message: string }[];
  log: string[];
}

export interface BenchmarkResult {
  id: string;
  name: string;
  /** Unit is part of the result so the UI never guesses. */
  unit: 'ms' | 'bytes' | 'percent' | 'count' | 'ratio';
  value: number;
  samples: number;
  detail: string;
  ranAt: number;
}

export interface RestorePoint {
  id: string;
  createdAt: number;
  reason: string;
  /** Files captured in this restore point. */
  entries: { path: string; existed: boolean; sizeBytes: number }[];
  /** True once the restore point has been rolled back. */
  restored: boolean;
}

export interface SearchHit {
  kind: 'page' | 'setting' | 'profile' | 'flag' | 'asset' | 'action' | 'command';
  id: string;
  title: string;
  subtitle: string;
  /** Where activating this hit takes the user. */
  route: string;
  score: number;
}

export interface CommandDescriptor {
  id: string;
  title: string;
  group: string;
  keywords: string[];
  shortcut?: string;
  /** Commands that cannot run right now are shown disabled with a reason. */
  unavailableReason?: string;
}
