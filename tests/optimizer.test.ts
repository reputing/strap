import { describe, expect, it } from 'vitest';
import { buildPlan, flagsFromPlan, recommendPreset, removalsFromPlan } from '@main/optimizer/planner';
import { OPTIMIZATION_CATALOG, allManagedFlags, findAction } from '@main/optimizer/catalog';
import { applyPlanToFlags } from '@main/optimizer/optimizer-service';
import { checkValue } from '@main/fastflags/flag-syntax';
import { findFlag } from '@main/fastflags/catalog';
import type { HardwareProfile, PresetId } from '@shared/types';

function hardware(patch: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    cpu: { model: 'Test CPU', cores: 8, threads: 16, speedMhz: 3600 },
    memory: { totalBytes: 16 * 1024 ** 3, freeBytes: 8 * 1024 ** 3 },
    gpu: [{ model: 'Test GPU', vendor: 'NVIDIA', memoryBytes: null }],
    os: { name: 'Windows 11', version: '10.0.22631', build: '22631', arch: 'x64' },
    tier: 'high',
    probedAt: Date.now(),
    ...patch
  };
}

const ctx = (patch: Partial<Parameters<typeof buildPlan>[0]> = {}) => ({
  preset: 'balanced' as PresetId,
  overrides: {},
  hardware: hardware(),
  install: null,
  currentFlags: {},
  currentPriority: 'normal' as const,
  ...patch
});

describe('catalog integrity', () => {
  it('every flag an action writes is a valid value for its flag type', () => {
    for (const action of OPTIMIZATION_CATALOG) {
      for (const [name, value] of Object.entries(action.flags ?? {})) {
        const check = checkValue(name, value);
        expect(check.ok, `${action.id} sets ${name}=${value}`).toBe(true);
      }
    }
  });

  it('every flag an action writes is described in the flag catalog', () => {
    for (const action of OPTIMIZATION_CATALOG) {
      for (const name of Object.keys(action.flags ?? {})) {
        expect(findFlag(name), `${action.id} writes undocumented ${name}`).not.toBeNull();
      }
    }
  });

  it('no action claims a frame rate number', () => {
    for (const action of OPTIMIZATION_CATALOG) {
      const text = `${action.description} ${action.expectedEffect}`;
      expect(text, action.id).not.toMatch(/\b\d+\s*%\s*(more|faster|fps)/i);
      expect(text, action.id).not.toMatch(/\bgain\s+\d+\s*fps/i);
    }
  });

  it('has unique ids and non-empty descriptions', () => {
    const ids = new Set<string>();
    for (const action of OPTIMIZATION_CATALOG) {
      expect(ids.has(action.id)).toBe(false);
      ids.add(action.id);
      expect(action.description.length).toBeGreaterThan(20);
      expect(action.expectedEffect.length).toBeGreaterThan(20);
    }
  });
});

describe('planning', () => {
  it('selects the actions a preset includes', () => {
    const plan = buildPlan(ctx({ preset: 'performance' }));
    expect(plan.actions.length).toBeGreaterThan(0);
    for (const action of plan.actions) expect(action.presets).toContain('performance');
  });

  it('custom selects nothing without explicit overrides', () => {
    expect(buildPlan(ctx({ preset: 'custom' })).actions).toHaveLength(0);
    const withOverride = buildPlan(ctx({ preset: 'custom', overrides: { 'render.disable-shadows': true } }));
    expect(withOverride.actions.map((a) => a.id)).toEqual(['render.disable-shadows']);
  });

  it('an override can remove an action the preset would include', () => {
    const base = buildPlan(ctx({ preset: 'performance' }));
    const id = base.actions[0]!.id;
    const trimmed = buildPlan(ctx({ preset: 'performance', overrides: { [id]: false } }));
    expect(trimmed.actions.map((a) => a.id)).not.toContain(id);
  });

  it('skips the large mesh cache on a low-memory machine and says why', () => {
    const plan = buildPlan(ctx({
      preset: 'custom',
      overrides: { 'memory.larger-mesh-cache': true },
      hardware: hardware({ memory: { totalBytes: 8 * 1024 ** 3, freeBytes: 2 * 1024 ** 3 } })
    }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0]?.actionId).toBe('memory.larger-mesh-cache');
    expect(plan.skipped[0]?.reason).toMatch(/8\.0 GB/);
  });

  it('skips compositor jobs on a low-thread CPU', () => {
    const plan = buildPlan(ctx({
      preset: 'custom',
      overrides: { 'process.texture-compositor-jobs': true },
      hardware: hardware({ cpu: { model: 'x', cores: 1, threads: 2, speedMhz: null } })
    }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toMatch(/at least four/);
  });

  it('skips hardware-dependent actions entirely when hardware is unknown', () => {
    const plan = buildPlan(ctx({
      preset: 'custom',
      overrides: { 'memory.larger-mesh-cache': true, 'process.texture-compositor-jobs': true },
      hardware: null
    }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
  });

  it('never selects two graphics backend preferences at once', () => {
    const plan = buildPlan(ctx({ preset: 'performance' }));
    const backends = plan.changes.filter((c) =>
      ['FFlagDebugGraphicsPreferD3D11', 'FFlagDebugGraphicsPreferVulkan', 'FFlagDebugGraphicsPreferD3D11FL10']
        .includes(c.key) && c.nextValue === 'True');
    expect(backends.length).toBeLessThanOrEqual(1);
  });

  it('shows the current value alongside the next one', () => {
    const plan = buildPlan(ctx({
      preset: 'balanced',
      currentFlags: { DFIntTaskSchedulerTargetFps: '60' }
    }));
    const change = plan.changes.find((c) => c.key === 'DFIntTaskSchedulerTargetFps');
    expect(change?.currentValue).toBe('60');
    expect(change?.nextValue).toBe('240');
  });

  it('plans the removal of managed flags a new preset no longer wants', () => {
    const plan = buildPlan(ctx({
      preset: 'conservative',
      currentFlags: { FFlagDisablePostFx: 'True', FFlagSomethingTheUserAdded: 'True' }
    }));
    expect(removalsFromPlan(plan)).toContain('FFlagDisablePostFx');
    expect(removalsFromPlan(plan)).not.toContain('FFlagSomethingTheUserAdded');
  });

  it('records a process change for the priority action', () => {
    const plan = buildPlan(ctx({ preset: 'custom', overrides: { 'process.above-normal-priority': true } }));
    const change = plan.changes.find((c) => c.mechanism === 'process');
    expect(change?.key).toBe('priority');
    expect(change?.nextValue).toBe('above-normal');
  });
});

describe('applying a plan to flags', () => {
  it('adds the plan\'s flags and removes what it no longer wants, keeping user flags', () => {
    const current = { FFlagDisablePostFx: 'True', FFlagUserOwn: 'True' };
    const plan = buildPlan(ctx({ preset: 'conservative', currentFlags: current }));
    const next = applyPlanToFlags(current, plan);

    expect(next['FFlagDisablePostFx']).toBeUndefined();
    expect(next['FFlagUserOwn']).toBe('True');
    expect(next['DFIntTaskSchedulerTargetFps']).toBe('144');
  });

  it('is idempotent', () => {
    const plan = buildPlan(ctx({ preset: 'performance' }));
    const once = applyPlanToFlags({}, plan);
    const twice = applyPlanToFlags(once, buildPlan(ctx({ preset: 'performance', currentFlags: once })));
    expect(twice).toEqual(once);
  });

  it('produces only flags the flag catalog documents', () => {
    for (const preset of ['conservative', 'balanced', 'performance', 'low-end'] as PresetId[]) {
      const flags = flagsFromPlan(buildPlan(ctx({ preset })));
      for (const name of Object.keys(flags)) expect(findFlag(name), `${preset}: ${name}`).not.toBeNull();
    }
  });
});

describe('recommendation', () => {
  it('suggests low-end for a weak machine', () => {
    const r = recommendPreset(hardware({ tier: 'low', memory: { totalBytes: 4 * 1024 ** 3, freeBytes: 1 } }));
    expect(r.preset).toBe('low-end');
    expect(r.reason).toContain('4 GB');
  });

  it('suggests performance for a strong machine', () => {
    expect(recommendPreset(hardware({ tier: 'high' })).preset).toBe('performance');
  });

  it('falls back to balanced when hardware is unknown', () => {
    const r = recommendPreset(null);
    expect(r.preset).toBe('balanced');
    expect(r.reason).toMatch(/not available/);
  });
});

describe('managed flags', () => {
  it('covers every flag any action can write', () => {
    const managed = new Set(allManagedFlags());
    for (const action of OPTIMIZATION_CATALOG) {
      for (const name of Object.keys(action.flags ?? {})) expect(managed.has(name)).toBe(true);
    }
  });

  it('looks up actions by id', () => {
    expect(findAction('render.disable-shadows')?.title).toBe('Remove dynamic shadows');
    expect(findAction('nope')).toBeNull();
  });
});
