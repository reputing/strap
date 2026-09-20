export type RobloxKind = 'player' | 'studio';

export type RobloxChannel = 'LIVE' | (string & {});

/** A single installed Roblox version directory. */
export interface RobloxInstallation {
  kind: RobloxKind;
  /** Version GUID, e.g. "version-0123456789abcdef". */
  versionGuid: string;
  /** Marketing version, e.g. "0.678.1.6780512". Null when it cannot be read. */
  clientVersion: string | null;
  /** Absolute path of the version directory. */
  directory: string;
  /** Absolute path of RobloxPlayerBeta.exe / RobloxStudioBeta.exe. */
  executable: string;
  /** Install flavour: the normal per-user install, or the Microsoft Store package. */
  source: 'user' | 'store' | 'unknown';
  /** Last write time of the executable, ms since epoch. */
  installedAt: number;
}

export interface RobloxState {
  /** Installations found on disk, newest first. */
  installations: RobloxInstallation[];
  /** The installation Blossom will launch and modify. */
  active: RobloxInstallation | null;
  /** Live processes we are tracking. */
  processes: RobloxProcess[];
  /** Latest version published by Roblox for the configured channel, if known. */
  latest: { channel: RobloxChannel; clientVersion: string; versionGuid: string } | null;
  /** Whether `active` is behind `latest`. */
  updateAvailable: boolean;
  scannedAt: number;
}

export interface RobloxProcess {
  pid: number;
  kind: RobloxKind;
  startedAt: number;
  executable: string | null;
  /** Launched by Blossom in this session. */
  ownedByBlossom: boolean;
}

/** One sample of a tracked process. Only fields we can actually read are present. */
export interface ProcessSample {
  pid: number;
  at: number;
  /** Percent of one core-second per wall second, 0..(100 * cores). */
  cpuPercent: number | null;
  /** Working set, bytes. */
  memoryBytes: number | null;
  uptimeMs: number;
}

export type LaunchStage =
  | 'idle'
  | 'resolving-profile'
  | 'locating-roblox'
  | 'validating'
  | 'creating-restore-point'
  | 'applying-fastflags'
  | 'applying-mods'
  | 'starting-interception'
  | 'starting-overlays'
  | 'spawning'
  | 'waiting-for-process'
  | 'running'
  | 'exited'
  | 'failed';

export interface LaunchProgress {
  stage: LaunchStage;
  message: string;
  /** 0..1 for the pre-launch portion; null once running. */
  fraction: number | null;
}

export interface LaunchRequest {
  kind?: RobloxKind;
  profileId?: string;
  /** Roblox deeplink (roblox://... / roblox-player:...) forwarded from the protocol handler. */
  deeplink?: string;
  /** Extra arguments appended verbatim. Advanced, opt-in. */
  extraArgs?: string[];
}

export interface LaunchOutcome {
  pid: number;
  versionGuid: string;
  restorePointId: string | null;
  startedAt: number;
  interception: 'off' | 'active' | 'degraded' | 'failed';
}

/**
 * A summary of what a launch is about to do, shown before it happens when the
 * user has asked to confirm launches.
 */
export interface LaunchPreview {
  profileName: string;
  clientVersion: string | null;
  fastFlagCount: number;
  modFileCount: number;
  assetRuleCount: number;
  interception: boolean;
  capture: boolean;
  overlays: string[];
  priority: string;
  /** Files Blossom will back up and then write. */
  filesTouched: string[];
}
