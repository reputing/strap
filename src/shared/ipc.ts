import type { Result } from './result';
import type {
  AppSettings, AssetPage, AssetQuery, AssetRule, AssetRuleSet, BenchmarkResult,
  CacheStats, CachedAsset, CaptureEvent, CommandDescriptor, DiagnosticsReport,
  FlagDefinition, FlagDiffRow, FlagValidationIssue, HardwareProfile, InterceptionState,
  LaunchOutcome, LaunchProgress, LaunchRequest, LogRecord, OptimizationAction,
  OptimizationPlan, OptimizerState, PresetId, Profile, ProcessSample, RestorePoint,
  RobloxState, SearchHit, ValidationReport
} from './types';

/**
 * The full request surface exposed to the renderer. Anything not listed here is
 * unreachable from the UI — the preload bridge is generated from these keys.
 *
 * Every handler returns `Result<T>`; the IPC layer converts thrown errors, so
 * the renderer only ever sees `{ ok: false, error }`.
 */
export interface IpcRequests {
  // ── app ────────────────────────────────────────────────────────────────
  'app:info': { params: void; result: { version: string; channel: string; electron: string; node: string; chrome: string; platform: string; portable: boolean } };
  'app:settings:get': { params: void; result: AppSettings };
  'app:settings:update': { params: Partial<AppSettings>; result: AppSettings };
  'app:settings:reset': { params: void; result: AppSettings };
  'app:window': { params: 'minimise' | 'maximise' | 'close' | 'hide'; result: void };
  'app:open-path': { params: { target: 'roblox' | 'blossom' | 'logs' | 'cache' | 'backups' | 'profiles' | 'custom'; custom?: string }; result: void };
  'app:open-external': { params: string; result: void };
  'app:quit': { params: void; result: void };

  // ── search & commands ──────────────────────────────────────────────────
  'search:query': { params: string; result: SearchHit[] };
  'commands:list': { params: void; result: CommandDescriptor[] };
  'commands:run': { params: { id: string; arg?: string }; result: void };

  // ── roblox ─────────────────────────────────────────────────────────────
  'roblox:state': { params: void; result: RobloxState };
  'roblox:rescan': { params: void; result: RobloxState };
  'roblox:check-latest': { params: void; result: RobloxState['latest'] };
  'roblox:set-active': { params: string; result: RobloxState };
  'roblox:repair': { params: void; result: { removed: string[]; restored: string[] } };
  'roblox:clear-temp-cache': { params: void; result: { filesRemoved: number; bytesFreed: number } };

  // ── launcher ───────────────────────────────────────────────────────────
  'launch:start': { params: LaunchRequest; result: LaunchOutcome };
  'launch:cancel': { params: void; result: void };
  'launch:close-roblox': { params: { pid?: number }; result: { closed: number } };

  // ── profiles ───────────────────────────────────────────────────────────
  'profiles:list': { params: void; result: Profile[] };
  'profiles:get': { params: string; result: Profile };
  'profiles:create': { params: { name: string; from?: string }; result: Profile };
  'profiles:update': { params: { id: string; patch: Partial<Profile> }; result: Profile };
  'profiles:delete': { params: string; result: void };
  'profiles:duplicate': { params: { id: string; name: string }; result: Profile };
  'profiles:activate': { params: string; result: Profile };
  'profiles:validate': { params: string; result: ValidationReport };
  'profiles:export': { params: { id: string; path?: string }; result: { path: string } };
  'profiles:import': { params: { path?: string; json?: string }; result: { profile: Profile; report: ValidationReport } };

  // ── fastflags ──────────────────────────────────────────────────────────
  'flags:catalog': { params: void; result: FlagDefinition[] };
  'flags:diff': { params: { profileId?: string }; result: FlagDiffRow[] };
  'flags:validate': { params: Record<string, string>; result: FlagValidationIssue[] };
  'flags:set': { params: { profileId?: string; flags: Record<string, string> }; result: Profile };
  'flags:remove': { params: { profileId?: string; names: string[] }; result: Profile };
  'flags:import': { params: { json: string; profileId?: string; merge: boolean }; result: { profile: Profile; issues: FlagValidationIssue[] } };
  'flags:export': { params: { profileId?: string }; result: string };
  'flags:apply-now': { params: void; result: { path: string; flagCount: number } };
  'flags:clear-applied': { params: void; result: void };

  // ── optimizer ──────────────────────────────────────────────────────────
  'optimizer:catalog': { params: void; result: OptimizationAction[] };
  'optimizer:hardware': { params: { refresh?: boolean }; result: HardwareProfile };
  'optimizer:state': { params: void; result: OptimizerState };
  'optimizer:plan': { params: { preset: PresetId; overrides?: Record<string, boolean> }; result: OptimizationPlan };
  'optimizer:apply': { params: { preset: PresetId; overrides?: Record<string, boolean> }; result: OptimizerState };
  'optimizer:undo': { params: void; result: OptimizerState };
  'optimizer:reset-defaults': { params: void; result: OptimizerState };
  'optimizer:recommend': { params: void; result: { preset: PresetId; reason: string } };

  // ── mods ───────────────────────────────────────────────────────────────
  'mods:list': { params: void; result: { relativePath: string; sizeBytes: number; applied: boolean; backedUp: boolean }[] };
  'mods:apply': { params: void; result: { applied: number; restorePointId: string } };
  'mods:restore': { params: void; result: { restored: number } };
  'mods:open-folder': { params: void; result: void };

  // ── assets ─────────────────────────────────────────────────────────────
  'assets:sets': { params: void; result: AssetRuleSet[] };
  'assets:set:create': { params: { name: string; description?: string }; result: AssetRuleSet };
  'assets:set:update': { params: { id: string; patch: Partial<AssetRuleSet> }; result: AssetRuleSet };
  'assets:set:delete': { params: string; result: void };
  'assets:set:duplicate': { params: { id: string; name: string }; result: AssetRuleSet };
  'assets:set:reorder': { params: string[]; result: AssetRuleSet[] };
  'assets:set:export': { params: { id: string; path?: string }; result: { path: string } };
  'assets:set:import': { params: { path?: string; json?: string }; result: AssetRuleSet };
  'assets:rules': { params: { setId: string }; result: AssetRule[] };
  'assets:rule:upsert': { params: Partial<AssetRule> & { setId: string; source: string }; result: AssetRule };
  'assets:rule:delete': { params: string; result: void };
  'assets:rule:test': { params: { assetId: string }; result: { rule: AssetRule | null; setId: string | null; reason: string } };

  // ── cache ──────────────────────────────────────────────────────────────
  'cache:query': { params: AssetQuery; result: AssetPage };
  'cache:get': { params: string; result: CachedAsset };
  'cache:stats': { params: void; result: CacheStats };
  'cache:preview': { params: { assetId: string; kind: 'auto' | 'raw' }; result: { mime: string; dataUrl: string | null; text: string | null; meta: Record<string, string | number> } };
  'cache:blob-path': { params: string; result: { path: string } };
  'cache:export': { params: { assetIds: string[]; directory?: string }; result: { exported: number; directory: string } };
  'cache:delete': { params: { assetIds: string[] }; result: { deleted: number; bytesFreed: number } };
  'cache:duplicates': { params: void; result: { hash: string; assetIds: string[]; sizeBytes: number }[] };
  'cache:clear': { params: void; result: { deleted: number; bytesFreed: number } };
  'cache:import-file': { params: { assetId: string; path: string }; result: CachedAsset };

  // ── interception & capture ─────────────────────────────────────────────
  'interception:state': { params: void; result: InterceptionState };
  'interception:start': { params: void; result: InterceptionState };
  'interception:stop': { params: void; result: InterceptionState };
  'interception:install-certificate': { params: { confirm: true }; result: { installed: boolean; path: string } };
  'interception:remove-certificate': { params: void; result: { removed: boolean } };
  'interception:explain': { params: void; result: { changes: { target: string; description: string; reversible: boolean }[]; requiresElevation: boolean } };
  'capture:start': { params: void; result: void };
  'capture:stop': { params: void; result: void };
  'capture:state': { params: void; result: { active: boolean; count: number; dropped: number; source: 'proxy' | 'roblox-cache' | 'none' } };
  'capture:recent': { params: { limit?: number }; result: CaptureEvent[] };
  'capture:clear': { params: void; result: void };
  'capture:export': { params: { path?: string }; result: { path: string; count: number } };

  // ── overlay ────────────────────────────────────────────────────────────
  'overlay:state': { params: void; result: { crosshair: boolean; hud: boolean; attachedPid: number | null; supported: boolean; detail: string | null } };
  'overlay:set-crosshair': { params: boolean; result: void };
  'overlay:set-hud': { params: boolean; result: void };
  'overlay:preview': { params: { enabled: boolean }; result: void };

  // ── diagnostics ────────────────────────────────────────────────────────
  'diagnostics:report': { params: void; result: DiagnosticsReport };
  'diagnostics:save': { params: { path?: string }; result: { path: string } };
  'diagnostics:logs': { params: { limit?: number; level?: LogRecord['level'] }; result: LogRecord[] };
  'diagnostics:benchmark': { params: { id: 'startup' | 'memory' | 'asset-loading' | 'configuration' | 'launch-time' | 'all' }; result: BenchmarkResult[] };
  'diagnostics:benchmarks': { params: void; result: BenchmarkResult[] };

  // ── backups ────────────────────────────────────────────────────────────
  'backups:list': { params: void; result: RestorePoint[] };
  'backups:restore': { params: string; result: { restored: number } };
  'backups:delete': { params: string; result: void };
  'backups:prune': { params: { keep: number }; result: { deleted: number } };

  // ── updates ────────────────────────────────────────────────────────────
  'updates:check': { params: { force?: boolean }; result: { available: boolean; version: string | null; notes: string | null; channel: string } };
  'updates:download': { params: void; result: { staged: boolean; path: string | null } };
  'updates:install': { params: void; result: void };
  'updates:state': { params: void; result: { phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'staged' | 'failed'; progress: number; version: string | null; error: string | null } };
}

/** Push channels: main → renderer. */
export interface IpcEvents {
  'roblox:changed': RobloxState;
  'roblox:sample': ProcessSample;
  'launch:progress': LaunchProgress;
  'profiles:changed': Profile[];
  'settings:changed': AppSettings;
  'interception:changed': InterceptionState;
  'capture:event': CaptureEvent[];
  'cache:changed': CacheStats;
  'optimizer:changed': OptimizerState;
  'log:record': LogRecord;
  'updates:changed': { phase: string; progress: number; version: string | null; error: string | null };
  'toast': { kind: 'info' | 'success' | 'warning' | 'error'; title: string; message?: string };
  'navigate': { route: string };
}

export type IpcChannel = keyof IpcRequests;
export type IpcParams<C extends IpcChannel> = IpcRequests[C]['params'];
export type IpcResult<C extends IpcChannel> = IpcRequests[C]['result'];

export type IpcEventName = keyof IpcEvents;
export type IpcEventPayload<E extends IpcEventName> = IpcEvents[E];

/** The shape contextBridge exposes on `window.blossom`. */
export interface BlossomBridge {
  invoke<C extends IpcChannel>(channel: C, params: IpcParams<C>): Promise<Result<IpcResult<C>>>;
  on<E extends IpcEventName>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}

export const IPC_REQUEST_CHANNEL = 'blossom:invoke';
export const IPC_EVENT_CHANNEL = 'blossom:event';
