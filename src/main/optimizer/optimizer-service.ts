import { EventEmitter } from 'node:events';
import type {
  HardwareProfile, OptimizationAction, OptimizationPlan, OptimizerState, PresetId
} from '@shared/types';
import { Err, Ok, type Result } from '@shared/result';
import type { ScopedLogger } from '@main/core/logger';
import type { PlatformAdapter } from '@main/platform';
import type { ProfileService } from '@main/profiles/profile-service';
import type { RobloxService } from '@main/roblox/roblox-service';
import { OPTIMIZATION_CATALOG, allManagedFlags } from './catalog';
import { buildPlan, flagsFromPlan, recommendPreset, removalsFromPlan } from './planner';

/**
 * The optimizer.
 *
 * Applying a preset writes into the *profile*, not straight into Roblox's
 * files. The launcher is the single place that touches the client, which means
 * the optimizer inherits its restore points and rollback for free, and the user
 * can see the whole effect of a preset before Roblox is ever started.
 *
 * `Undo` restores the flag values recorded before the last apply.
 * `Reset to Roblox defaults` removes every flag this catalog is capable of
 * writing — it does not guess at Roblox's own values.
 */
export class OptimizerService extends EventEmitter {
  private hardware: HardwareProfile | null = null;
  private appliedActionIds: string[] = [];
  private appliedAt: number | null = null;
  /** Flag state captured immediately before the last apply. */
  private undoSnapshot: { profileId: string; flags: Record<string, string>; preset: PresetId } | null = null;

  constructor(
    private readonly platform: PlatformAdapter,
    private readonly profiles: ProfileService,
    private readonly roblox: RobloxService,
    private readonly log: ScopedLogger
  ) {
    super();
  }

  catalog(): OptimizationAction[] {
    return OPTIMIZATION_CATALOG;
  }

  async probeHardware(refresh = false): Promise<Result<HardwareProfile>> {
    if (this.hardware && !refresh) return Ok(this.hardware);

    const r = await this.platform.queryHardware();
    if (!r.ok) {
      this.log.warn('Hardware details are unavailable', { reason: r.error.message });
      return r;
    }
    this.hardware = r.value;
    this.log.info('Hardware probed', {
      cpu: r.value.cpu.model, threads: r.value.cpu.threads,
      memoryGb: Math.round(r.value.memory.totalBytes / 1024 ** 3), tier: r.value.tier
    });
    return Ok(r.value);
  }

  state(): OptimizerState {
    const profile = this.profiles.active();
    return {
      preset: profile.optimizer.preset,
      appliedActionIds: this.appliedActionIds,
      appliedAt: this.appliedAt,
      // Optimizations are written into the profile, and `undo` replays the
      // snapshot taken before the last apply rather than a file backup.
      restorePointId: this.undoSnapshot ? `profile:${this.undoSnapshot.profileId}` : null,
      hardware: this.hardware
    };
  }

  async recommend(): Promise<{ preset: PresetId; reason: string }> {
    await this.probeHardware();
    return recommendPreset(this.hardware);
  }

  /** Builds a plan without applying anything. */
  async plan(preset: PresetId, overrides?: Record<string, boolean>): Promise<OptimizationPlan> {
    await this.probeHardware();
    const profile = this.profiles.active();

    return buildPlan({
      preset,
      overrides: overrides ?? profile.optimizer.overrides,
      hardware: this.hardware,
      install: this.roblox.active(profile.launcher.kind),
      currentFlags: profile.fastFlags,
      currentPriority: profile.launcher.priority
    });
  }

  /**
   * Applies a preset to the active profile. The previous flag state is captured
   * first so `undo` is exact rather than "remove what we think we added".
   */
  async apply(preset: PresetId, overrides?: Record<string, boolean>): Promise<Result<OptimizerState>> {
    const profile = this.profiles.active();
    const plan = await this.plan(preset, overrides);

    this.undoSnapshot = {
      profileId: profile.id,
      flags: { ...profile.fastFlags },
      preset: profile.optimizer.preset
    };

    const next = applyPlanToFlags(profile.fastFlags, plan);
    const updated = await this.profiles.update(profile.id, {
      fastFlags: next,
      optimizer: { preset, overrides: overrides ?? profile.optimizer.overrides },
      launcher: {
        ...profile.launcher,
        priority: plan.actions.some((a) => a.id === 'process.above-normal-priority')
          ? 'above-normal'
          : profile.launcher.priority === 'above-normal'
            ? 'normal'
            : profile.launcher.priority
      }
    });

    if (!updated.ok) {
      this.undoSnapshot = null;
      return updated;
    }

    // Editing a built-in profile forks it; follow the fork so undo targets the
    // profile that actually changed.
    if (updated.value.id !== profile.id && this.undoSnapshot) {
      this.undoSnapshot.profileId = updated.value.id;
    }

    this.appliedActionIds = plan.actions.map((a) => a.id);
    this.appliedAt = Date.now();

    this.log.info('Optimization preset applied', {
      preset,
      actions: plan.actions.length,
      skipped: plan.skipped.length,
      profile: updated.value.name
    });
    for (const s of plan.skipped) {
      this.log.debug('Optimization skipped', { action: s.actionId, reason: s.reason });
    }

    this.emit('changed', this.state());
    return Ok(this.state());
  }

  /** Puts flags back exactly as they were before the last apply. */
  async undo(): Promise<Result<OptimizerState>> {
    const snapshot = this.undoSnapshot;
    if (!snapshot) {
      return Err('not-found', 'There is nothing to undo.', {
        remediation: 'Undo is available immediately after applying a preset.'
      });
    }

    const updated = await this.profiles.update(snapshot.profileId, {
      fastFlags: snapshot.flags,
      optimizer: { preset: snapshot.preset, overrides: {} }
    });
    if (!updated.ok) return updated;

    this.undoSnapshot = null;
    this.appliedActionIds = [];
    this.appliedAt = null;
    this.log.info('Optimization undone', { profile: updated.value.name });
    this.emit('changed', this.state());
    return Ok(this.state());
  }

  /**
   * Removes every flag this optimizer is capable of setting, leaving anything
   * the user added by hand alone.
   */
  async resetToDefaults(): Promise<Result<OptimizerState>> {
    const profile = this.profiles.active();
    const managed = new Set(allManagedFlags());

    const remaining: Record<string, string> = {};
    let removed = 0;
    for (const [name, value] of Object.entries(profile.fastFlags)) {
      if (managed.has(name)) removed += 1;
      else remaining[name] = value;
    }

    const updated = await this.profiles.update(profile.id, {
      fastFlags: remaining,
      optimizer: { preset: 'conservative', overrides: {} },
      launcher: { ...profile.launcher, priority: 'normal' }
    });
    if (!updated.ok) return updated;

    this.undoSnapshot = null;
    this.appliedActionIds = [];
    this.appliedAt = null;
    this.log.info('Optimizations reset to Roblox defaults', {
      removedFlags: removed,
      keptUserFlags: Object.keys(remaining).length
    });
    this.emit('changed', this.state());
    return Ok(this.state());
  }
}

/** Merges a plan's additions and removals into an existing flag set. */
export function applyPlanToFlags(
  current: Record<string, string>,
  plan: OptimizationPlan
): Record<string, string> {
  const next = { ...current };
  for (const name of removalsFromPlan(plan)) delete next[name];
  return { ...next, ...flagsFromPlan(plan) };
}
