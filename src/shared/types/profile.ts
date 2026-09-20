import type { RobloxKind } from './roblox';

export const PROFILE_SCHEMA_VERSION = 1;

export type ProcessPriority = 'normal' | 'above-normal' | 'high';

export interface LauncherConfig {
  kind: RobloxKind;
  /** Allow more than one Roblox client at a time. */
  multiInstance: boolean;
  /** Windows process priority applied after launch. */
  priority: ProcessPriority;
  /** Explicit CPU affinity mask; null means "leave it to Windows". */
  affinityMask: number | null;
  /** Arguments appended to the Roblox command line. */
  extraArgs: string[];
  /** What Blossom does once the client exits. */
  onExit: 'restore' | 'keep' | 'quit-blossom';
  /** Close Blossom's window (not the process) once Roblox is up. */
  hideOnLaunch: boolean;
}

export interface OptimizerConfig {
  preset: 'conservative' | 'balanced' | 'performance' | 'low-end' | 'custom';
  /** Per-action overrides on top of the preset: action id → enabled. */
  overrides: Record<string, boolean>;
}

export interface AssetsConfig {
  /** Master switch for the interception engine for this profile. */
  interception: boolean;
  /** Asset rule-set ids applied, in order. */
  assetProfileIds: string[];
  /** Record every asset the client requests while this profile is active. */
  capture: boolean;
}

export interface CrosshairConfig {
  enabled: boolean;
  style: 'cross' | 'dot' | 'cross-dot' | 'circle' | 't-shape';
  size: number;
  thickness: number;
  gap: number;
  color: string;
  opacity: number;
  outline: boolean;
  outlineColor: string;
  /** Pixel nudge from the exact centre of the Roblox window. */
  offsetX: number;
  offsetY: number;
}

export interface HudConfig {
  enabled: boolean;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  showFps: boolean;
  showCpu: boolean;
  showMemory: boolean;
  showUptime: boolean;
  showPing: boolean;
  opacity: number;
  scale: number;
}

export interface OverlayConfig {
  crosshair: CrosshairConfig;
  hud: HudConfig;
}

export interface AppearanceConfig {
  accent: 'blossom' | 'violet' | 'rose' | 'mint' | 'amber';
  density: 'comfortable' | 'compact';
  reduceMotion: boolean;
}

export interface Profile {
  schemaVersion: number;
  id: string;
  name: string;
  description: string;
  /** Built-in profiles cannot be deleted; editing one forks it. */
  builtIn: boolean;
  createdAt: number;
  updatedAt: number;
  launcher: LauncherConfig;
  /** Flag id → value. Values are stored as strings, exactly as Roblox reads them. */
  fastFlags: Record<string, string>;
  optimizer: OptimizerConfig;
  assets: AssetsConfig;
  overlay: OverlayConfig;
  appearance: AppearanceConfig;
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  severity: ValidationSeverity;
  /** Dotted path into the profile, e.g. "fastFlags.DFIntTaskSchedulerTargetFps". */
  path: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}
