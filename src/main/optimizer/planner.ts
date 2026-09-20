import type {
  HardwareProfile, OptimizationAction, OptimizationPlan, PlannedChange, PresetId, RobloxInstallation
} from '@shared/types';
import { OPTIMIZATION_CATALOG, findAction } from './catalog';
import { MUTUALLY_EXCLUSIVE } from '@main/fastflags/catalog';

export interface PlanContext {
  preset: PresetId;
  /** Per-action overrides on top of the preset: action id → enabled. */
  overrides: Record<string, boolean>;
  hardware: HardwareProfile | null;
  install: RobloxInstallation | null;
  /** Flags currently written by Blossom, so the plan can show what changes. */
  currentFlags: Record<string, string>;
  currentPriority: 'normal' | 'above-normal' | 'high';
}

/** Compatibility rules, evaluated against the machine and the client. */
type Compatibility = (ctx: PlanContext) => string | null;

const COMPATIBILITY: Record<string, Compatibility> = {
  'memory.larger-mesh-cache': (ctx) => {
    const gb = (ctx.hardware?.memory.totalBytes ?? 0) / 1024 ** 3;
    if (!ctx.hardware) return 'Hardware details are not available, so this memory-hungry option is left off.';
    return gb < 12 ? `This machine has ${gb.toFixed(1)} GB of RAM; a 512 MB mesh cache is not a good trade below 12 GB.` : null;
  },
  'process.texture-compositor-jobs': (ctx) => {
    const threads = ctx.hardware?.cpu.threads ?? 0;
    if (!ctx.hardware) return 'Hardware details are not available, so extra compositor jobs are left off.';
    return threads < 4 ? `This CPU reports ${threads} logical processors; extra compositing jobs need at least four.` : null;
  },
  'process.above-normal-priority': (ctx) =>
    ctx.hardware && ctx.hardware.cpu.threads <= 2
      ? 'Raising priority on a dual-thread CPU tends to make the rest of Windows stutter without helping the client.'
      : null
};

/**
 * Builds the exact set of changes a preset would make.
 *
 * The plan is produced before anything is written and is shown to the user, so
 * "what is Blossom about to do" has a literal answer rather than a promise.
 */
export function buildPlan(ctx: PlanContext): OptimizationPlan {
  const selected: OptimizationAction[] = [];
  const skipped: { actionId: string; reason: string }[] = [];

  for (const action of OPTIMIZATION_CATALOG) {
    const override = ctx.overrides[action.id];
    const includedByPreset = action.presets.includes(ctx.preset);
    const wanted = override ?? (ctx.preset === 'custom' ? false : includedByPreset);
    if (!wanted) continue;

    const incompatible = COMPATIBILITY[action.id]?.(ctx);
    if (incompatible) {
      skipped.push({ actionId: action.id, reason: incompatible });
      continue;
    }
    selected.push(action);
  }

  // Enforce cross-flag exclusivity: if two selected actions would set flags that
  // cannot coexist, keep the first and explain why the other was dropped.
  const kept: OptimizationAction[] = [];
  const claimed = new Map<string, string>();

  for (const action of selected) {
    let conflict: string | null = null;
    for (const rule of MUTUALLY_EXCLUSIVE) {
      const touches = Object.keys(action.flags ?? {}).filter((f) => rule.flags.includes(f));
      if (!touches.length) continue;
      for (const flag of rule.flags) {
        const owner = claimed.get(flag);
        if (owner && owner !== action.id) {
          conflict = `${rule.reason} Already set by "${findAction(owner)?.title ?? owner}".`;
          break;
        }
      }
      if (conflict) break;
      for (const flag of touches) claimed.set(flag, action.id);
    }

    if (conflict) skipped.push({ actionId: action.id, reason: conflict });
    else kept.push(action);
  }

  const changes: PlannedChange[] = [];
  const flagOwner = new Map<string, string>();

  for (const action of kept) {
    for (const [name, value] of Object.entries(action.flags ?? {})) {
      // Later actions in the catalog win a duplicate flag; record it once.
      const existingIndex = changes.findIndex((c) => c.mechanism === 'fastflag' && c.key === name);
      if (existingIndex >= 0) {
        changes[existingIndex] = {
          actionId: action.id,
          mechanism: 'fastflag',
          key: name,
          currentValue: ctx.currentFlags[name] ?? null,
          nextValue: value
        };
      } else {
        changes.push({
          actionId: action.id,
          mechanism: 'fastflag',
          key: name,
          currentValue: ctx.currentFlags[name] ?? null,
          nextValue: value
        });
      }
      flagOwner.set(name, action.id);
    }

    if (action.id === 'process.above-normal-priority') {
      changes.push({
        actionId: action.id,
        mechanism: 'process',
        key: 'priority',
        currentValue: ctx.currentPriority,
        nextValue: 'above-normal'
      });
    }
  }

  // Flags Blossom currently sets that this plan no longer wants are removals.
  for (const [name, value] of Object.entries(ctx.currentFlags)) {
    if (flagOwner.has(name)) continue;
    if (!isManagedFlag(name)) continue;
    changes.push({
      actionId: 'optimizer.remove',
      mechanism: 'fastflag',
      key: name,
      currentValue: value,
      nextValue: null
    });
  }

  return { preset: ctx.preset, actions: kept, changes, skipped, createdAt: Date.now() };
}

let managedCache: Set<string> | null = null;

function isManagedFlag(name: string): boolean {
  if (!managedCache) {
    managedCache = new Set<string>();
    for (const action of OPTIMIZATION_CATALOG) {
      for (const flag of Object.keys(action.flags ?? {})) managedCache.add(flag);
    }
  }
  return managedCache.has(name);
}

/**
 * Picks a starting preset for this machine. Deliberately blunt: a launcher that
 * pretends to score hardware precisely is making a promise it cannot keep.
 */
export function recommendPreset(hardware: HardwareProfile | null): { preset: PresetId; reason: string } {
  if (!hardware) {
    return {
      preset: 'balanced',
      reason: 'Hardware details are not available, so Balanced is the safe starting point.'
    };
  }

  const gb = hardware.memory.totalBytes / 1024 ** 3;
  const { threads } = hardware.cpu;

  if (hardware.tier === 'low') {
    return {
      preset: 'low-end',
      reason: `${gb.toFixed(0)} GB of RAM and ${threads} logical processors. Low End trades visual detail for headroom.`
    };
  }
  if (hardware.tier === 'high') {
    return {
      preset: 'performance',
      reason: `${gb.toFixed(0)} GB of RAM, ${threads} logical processors and a discrete GPU. Performance targets frame consistency.`
    };
  }
  return {
    preset: 'balanced',
    reason: `${gb.toFixed(0)} GB of RAM and ${threads} logical processors. Balanced removes the frame ceiling without changing how the game looks much.`
  };
}

/** The flag set a plan produces, ready to merge into a profile. */
export function flagsFromPlan(plan: OptimizationPlan): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const change of plan.changes) {
    if (change.mechanism !== 'fastflag') continue;
    if (change.nextValue === null) continue;
    flags[change.key] = change.nextValue;
  }
  return flags;
}

/** Flags a plan removes, so the applier knows what to delete. */
export function removalsFromPlan(plan: OptimizationPlan): string[] {
  return plan.changes
    .filter((c) => c.mechanism === 'fastflag' && c.nextValue === null)
    .map((c) => c.key);
}
