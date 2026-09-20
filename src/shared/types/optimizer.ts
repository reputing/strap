export type RiskLevel = 'safe' | 'low' | 'moderate' | 'advanced';

export type OptimizationMechanism =
  | 'fastflag'          // writes ClientSettings/ClientAppSettings.json
  | 'client-setting'    // writes Roblox's own GlobalBasicSettings XML
  | 'process'           // process priority / affinity, applied at launch
  | 'filesystem'        // files under the version directory
  | 'blossom';          // changes Blossom's own behaviour only

export type PresetId = 'conservative' | 'balanced' | 'performance' | 'low-end' | 'custom';

export interface OptimizationAction {
  id: string;
  title: string;
  /** What it does, mechanically. Not a marketing claim. */
  description: string;
  /** What the user should expect. Honest, including "no effect on some hardware". */
  expectedEffect: string;
  mechanism: OptimizationMechanism;
  risk: RiskLevel;
  reversible: boolean;
  category: 'rendering' | 'scheduler' | 'memory' | 'network' | 'input' | 'ui' | 'system';
  /** Flags this action writes, when mechanism is 'fastflag'. */
  flags?: Record<string, string>;
  /** Presets that include this action by default. */
  presets: PresetId[];
  /** Human-readable compatibility notes shown in the UI. */
  compatibility?: string;
}

export interface HardwareProfile {
  cpu: { model: string; cores: number; threads: number; speedMhz: number | null };
  memory: { totalBytes: number; freeBytes: number };
  gpu: { model: string; vendor: string; memoryBytes: number | null }[];
  os: { name: string; version: string; build: string | null; arch: string };
  /** Coarse tier used by the optimizer to pick defaults. */
  tier: 'low' | 'mid' | 'high';
  probedAt: number;
}

export interface PlannedChange {
  actionId: string;
  mechanism: OptimizationMechanism;
  /** Target of the change, e.g. a flag name or a file path. */
  key: string;
  /** null means "Blossom is not currently setting this". */
  currentValue: string | null;
  nextValue: string | null;
}

export interface OptimizationPlan {
  preset: PresetId;
  actions: OptimizationAction[];
  changes: PlannedChange[];
  /** Actions excluded because they are incompatible with this machine or client. */
  skipped: { actionId: string; reason: string }[];
  createdAt: number;
}

export interface OptimizerState {
  preset: PresetId;
  appliedActionIds: string[];
  appliedAt: number | null;
  /** Restore point that `undo` will roll back to. */
  restorePointId: string | null;
  hardware: HardwareProfile | null;
}
