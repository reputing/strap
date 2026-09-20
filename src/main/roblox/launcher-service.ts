import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import type {
  LaunchOutcome, LaunchProgress, LaunchRequest, LaunchStage, Profile, RobloxInstallation
} from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import type { PlatformAdapter } from '@main/platform';
import type { BackupService } from '@main/backups/backup-service';
import { exists } from '@main/core/fs-utils';
import { FastFlagService } from '@main/fastflags/fastflag-service';
import type { ModService } from '@main/mods/mod-service';
import type { RobloxService } from './roblox-service';
import type { ProcessMonitor } from './process-monitor';
import { validateProfile } from '@main/profiles/schema';

/** A step that has already run and knows how to undo itself. */
interface Compensation {
  what: string;
  undo: () => Promise<void>;
}

export interface InterceptionHook {
  /** Prepares interception and returns environment variables for the child. */
  prepare(profile: Profile, install: RobloxInstallation): Promise<Result<Record<string, string>>>;
  /** Called after the client exits, or when launch fails after `prepare`. */
  release(): Promise<void>;
  status(): 'off' | 'active' | 'degraded' | 'failed';
}

export interface OverlayHook {
  attach(pid: number, profile: Profile): Promise<void>;
  detach(): Promise<void>;
}

/**
 * Owns the whole Roblox launch.
 *
 * The launch is a sequence of steps, each of which registers how to undo
 * itself. A failure at any point runs the compensations in reverse, so a failed
 * launch never leaves the client half-modified.
 */
export class LauncherService extends EventEmitter {
  private launching = false;
  private cancelled = false;
  private compensations: Compensation[] = [];
  private currentRestorePoint: string | null = null;
  private activeProfile: Profile | null = null;

  constructor(
    private readonly roblox: RobloxService,
    private readonly monitor: ProcessMonitor,
    private readonly flags: FastFlagService,
    private readonly mods: ModService,
    private readonly backups: BackupService,
    private readonly platform: PlatformAdapter,
    private readonly log: ScopedLogger,
    private readonly hooks: { interception?: InterceptionHook; overlay?: OverlayHook } = {}
  ) {
    super();
    this.monitor.on('stopped', (p: { pid: number }) => void this.onRobloxExit(p.pid));
  }

  get isLaunching(): boolean {
    return this.launching;
  }

  private progress(stage: LaunchStage, message: string, fraction: number | null): void {
    this.emit('progress', { stage, message, fraction } satisfies LaunchProgress);
  }

  cancel(): void {
    if (this.launching) {
      this.cancelled = true;
      this.log.info('Launch cancelled by the user');
    }
  }

  async launch(request: LaunchRequest, profile: Profile): Promise<Result<LaunchOutcome>> {
    if (this.launching) {
      return Err('busy', 'A launch is already in progress.');
    }

    this.launching = true;
    this.cancelled = false;
    this.compensations = [];
    this.currentRestorePoint = null;

    try {
      return await this.run(request, profile);
    } catch (e) {
      this.log.error('Launch failed unexpectedly', { reason: e instanceof Error ? e.message : String(e) });
      await this.rollback();
      this.progress('failed', 'Launch failed.', null);
      return Err('launch-failed', 'Blossom could not start Roblox, and has put everything back.');
    } finally {
      this.launching = false;
    }
  }

  private async run(request: LaunchRequest, profile: Profile): Promise<Result<LaunchOutcome>> {
    const kind = request.kind ?? profile.launcher.kind;

    // 1 — profile
    this.progress('resolving-profile', `Loading profile "${profile.name}"`, 0.05);
    const report = validateProfile(profile);
    if (!report.valid) {
      const first = report.issues.find((i) => i.severity === 'error');
      return Err('profile-invalid', `Profile "${profile.name}" cannot be used: ${first?.message ?? 'it has errors.'}`, {
        remediation: 'Open the profile and fix the highlighted problems.'
      });
    }

    // 2 — installation
    this.progress('locating-roblox', 'Locating Roblox', 0.12);
    const install = this.roblox.require(kind);
    if (!install.ok) return install;

    // 3 — pre-flight
    this.progress('validating', 'Checking the installation', 0.2);
    const preflight = await this.preflight(install.value, profile, kind);
    if (!preflight.ok) return preflight;
    if (this.cancelled) return this.abort();

    // 4 — restore point
    this.progress('creating-restore-point', 'Backing up what we are about to change', 0.3);
    const touched = [FastFlagService.settingsPath(install.value)];
    const point = await this.backups.create(`Launch with "${profile.name}"`, touched);
    if (!point.ok) return point;
    this.currentRestorePoint = point.value;

    // 5 — flags
    this.progress('applying-fastflags', 'Applying FastFlags', 0.42);
    const applied = await this.flags.apply(install.value, profile.fastFlags);
    if (!applied.ok) {
      await this.rollback();
      return applied;
    }
    this.compensations.push({
      what: 'fastflags',
      undo: async () => { await this.backups.restore(point.value); }
    });
    if (this.cancelled) return this.abort();

    // 6 — mods
    this.progress('applying-mods', 'Applying client mods', 0.52);
    const modFiles = await this.mods.list(install.value);
    if (modFiles.length) {
      const modResult = await this.mods.apply(install.value);
      if (!modResult.ok) {
        await this.rollback();
        return modResult;
      }
      const modPoint = modResult.value.restorePointId;
      this.compensations.push({
        what: 'mods',
        undo: async () => { await this.backups.restore(modPoint); }
      });
    }
    if (this.cancelled) return this.abort();

    // 7 — interception
    let childEnv: Record<string, string> = {};
    if (profile.assets.interception && this.hooks.interception) {
      this.progress('starting-interception', 'Starting the asset engine', 0.62);
      const prepared = await this.hooks.interception.prepare(profile, install.value);
      if (prepared.ok) {
        childEnv = prepared.value;
        const hook = this.hooks.interception;
        this.compensations.push({ what: 'interception', undo: () => hook.release() });
      } else {
        // Interception is an enhancement, never a launch blocker: the client
        // starts without it and the UI reports why.
        this.log.warn('Interception could not start; launching without it', {
          reason: prepared.error.message
        });
        this.emit('interception-degraded', prepared.error);
      }
    }

    // 8/9 — argv and spawn
    this.progress('spawning', 'Starting Roblox', 0.78);
    const argv = buildArguments(request, profile);
    this.log.info('Launching Roblox', {
      kind,
      version: install.value.clientVersion ?? install.value.versionGuid,
      profile: profile.name,
      args: argv.length
    });

    const spawned = await this.spawnClient(install.value, argv, childEnv);
    if (!spawned.ok) {
      await this.rollback();
      return spawned;
    }

    // 10 — confirm the process actually came up
    this.progress('waiting-for-process', 'Waiting for the client', 0.9);
    const pid = await this.confirmStarted(spawned.value, kind);
    if (pid === null) {
      await this.rollback();
      return Err('launch-failed', 'Roblox was started but never appeared as a running process.', {
        remediation: 'Antivirus or a pending Roblox update can block the client. Try launching Roblox directly once, then use Blossom again.'
      });
    }

    this.monitor.claim(pid);
    this.activeProfile = profile;

    // 11 — post-launch process attributes and overlays
    await this.applyProcessAttributes(pid, profile);
    if (this.hooks.overlay) {
      this.progress('starting-overlays', 'Starting overlays', 0.96);
      await this.hooks.overlay.attach(pid, profile).catch((e: unknown) => {
        this.log.warn('Overlays could not start', { reason: e instanceof Error ? e.message : String(e) });
      });
    }

    this.progress('running', 'Roblox is running', null);
    this.log.info('Roblox launched', { pid });

    return Ok({
      pid,
      versionGuid: install.value.versionGuid,
      restorePointId: this.currentRestorePoint,
      startedAt: Date.now(),
      interception: this.hooks.interception?.status() ?? 'off'
    });
  }

  private async preflight(
    install: RobloxInstallation,
    profile: Profile,
    kind: Profile['launcher']['kind']
  ): Promise<Result<void>> {
    if (!profile.launcher.multiInstance && this.monitor.isRunning(kind)) {
      return Err('roblox-already-running', 'Roblox is already running.', {
        remediation: 'Close it first, or turn on multiple instances in the profile\'s launcher settings.'
      });
    }

    if (!(await exists(install.executable))) {
      return Err('roblox-not-found', 'The Roblox executable has moved or been removed.', {
        remediation: 'Press Rescan on the Home page, or reinstall Roblox.'
      });
    }

    return Ok(undefined);
  }

  private async spawnClient(
    install: RobloxInstallation,
    argv: string[],
    extraEnv: Record<string, string>
  ): Promise<Result<number>> {
    try {
      const child = spawn(install.executable, argv, {
        cwd: dirname(install.executable),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: { ...process.env, ...extraEnv }
      });

      const pid = child.pid;
      // Blossom must not be the parent that keeps the client alive, and the
      // client must not die when Blossom exits.
      child.unref();

      if (!pid) {
        return Err('launch-failed', 'Windows did not return a process id for Roblox.');
      }
      return Ok(pid);
    } catch (e) {
      return Err('launch-failed', 'Blossom could not start the Roblox executable.', {
        remediation: 'Check that the file is not blocked by antivirus.',
        details: { reason: e instanceof Error ? e.message : String(e) }
      });
    }
  }

  /**
   * Roblox's executable re-execs itself, so the pid we spawned is often not the
   * pid that ends up running. Wait for the monitor to report a live client
   * instead of trusting the spawn result.
   */
  private async confirmStarted(spawnedPid: number, kind: Profile['launcher']['kind']): Promise<number | null> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (this.cancelled) return null;
      const running = this.monitor.list().filter((p) => p.kind === kind);
      const match = running.find((p) => p.pid === spawnedPid) ?? running.at(-1);
      if (match) return match.pid;

      await delay(400);
      // Events may be unavailable on a machine without the Windows helper.
      if (!this.platform.operational) await this.monitor.refresh();
    }

    // One last direct check before giving up.
    await this.monitor.refresh();
    return this.monitor.list().find((p) => p.kind === kind)?.pid ?? null;
  }

  private async applyProcessAttributes(pid: number, profile: Profile): Promise<void> {
    if (profile.launcher.priority !== 'normal') {
      const r = await this.platform.setPriority(pid, profile.launcher.priority);
      if (r.ok) this.log.info('Process priority set', { pid, priority: profile.launcher.priority });
      else this.log.warn('Could not set the process priority', { reason: r.error.message });
    }
    if (profile.launcher.affinityMask !== null) {
      const r = await this.platform.setAffinity(pid, profile.launcher.affinityMask);
      if (r.ok) this.log.info('CPU affinity set', { pid, mask: profile.launcher.affinityMask });
      else this.log.warn('Could not set the CPU affinity', { reason: r.error.message });
    }
  }

  private async onRobloxExit(pid: number): Promise<void> {
    if (this.monitor.isRunning()) return; // Another client is still up.
    const profile = this.activeProfile;
    this.activeProfile = null;

    await this.hooks.overlay?.detach().catch(() => undefined);
    await this.hooks.interception?.release().catch(() => undefined);

    if (profile?.launcher.onExit === 'restore' && this.currentRestorePoint) {
      this.log.info('Roblox exited; restoring the client', { pid });
      await this.backups.restore(this.currentRestorePoint).catch(() => undefined);
    }
    this.currentRestorePoint = null;
    this.compensations = [];
    this.progress('exited', 'Roblox closed', null);
    this.emit('exited', { pid, profile });

    // Restoring first, then quitting: leaving a modified client behind because
    // the app exited too eagerly is exactly what the compensation design exists
    // to prevent.
    if (profile?.launcher.onExit === 'quit-blossom') {
      this.log.info('Profile asks Blossom to quit once Roblox exits');
      this.emit('quit-requested');
    }
  }

  private async abort(): Promise<Result<never>> {
    await this.rollback();
    this.progress('idle', 'Launch cancelled', null);
    return Err('cancelled', 'The launch was cancelled.');
  }

  /** Runs every registered compensation in reverse order. */
  private async rollback(): Promise<void> {
    for (const step of [...this.compensations].reverse()) {
      try {
        await step.undo();
        this.log.debug('Rolled back a launch step', { step: step.what });
      } catch (e) {
        this.log.error('A launch step could not be rolled back', {
          step: step.what,
          reason: e instanceof Error ? e.message : String(e)
        });
      }
    }
    this.compensations = [];
    this.currentRestorePoint = null;
  }
}

/**
 * Builds the client's command line.
 *
 * A deeplink from the protocol handler is passed through unchanged — it carries
 * the join ticket, and rewriting it is how launchers break joining.
 */
export function buildArguments(request: LaunchRequest, profile: Profile): string[] {
  const args: string[] = [];

  if (request.deeplink) {
    args.push(request.deeplink);
  } else {
    // With no deeplink the client opens to the home screen.
    args.push('--app');
  }

  for (const arg of profile.launcher.extraArgs) {
    if (arg && !/[\r\n\0]/.test(arg)) args.push(arg);
  }
  for (const arg of request.extraArgs ?? []) {
    if (arg && !/[\r\n\0]/.test(arg)) args.push(arg);
  }

  return args;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}
