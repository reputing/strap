import { describe, expect, it } from 'vitest';
import { coerceProfile, migrateProfile, validateProfile } from '@main/profiles/schema';
import { emptyProfile } from '@main/core/defaults';

describe('profile coercion', () => {
  it('turns arbitrary rubbish into a usable profile instead of throwing', () => {
    for (const input of [null, undefined, 42, 'nope', [], { name: 5 }]) {
      const p = coerceProfile(input);
      expect(p.schemaVersion).toBe(1);
      expect(typeof p.name).toBe('string');
      expect(p.launcher.kind).toBe('player');
    }
  });

  it('keeps values it understands', () => {
    const p = coerceProfile({
      id: 'comp',
      name: 'Comp',
      launcher: { kind: 'studio', priority: 'high', multiInstance: true, extraArgs: ['--a', 7] },
      fastFlags: { DFIntTaskSchedulerTargetFps: 144, FFlagX: true },
      optimizer: { preset: 'performance', overrides: { 'a': true, 'b': 'nope' } }
    });
    expect(p.id).toBe('comp');
    expect(p.launcher.kind).toBe('studio');
    expect(p.launcher.priority).toBe('high');
    expect(p.launcher.extraArgs).toEqual(['--a']);
    expect(p.fastFlags['DFIntTaskSchedulerTargetFps']).toBe('144');
    expect(p.fastFlags['FFlagX']).toBe('true');
    expect(p.optimizer.overrides).toEqual({ a: true });
  });

  it('falls back on out-of-range and malformed values', () => {
    const p = coerceProfile({
      launcher: { priority: 'ludicrous', affinityMask: -4 },
      optimizer: { preset: 'turbo' },
      appearance: { accent: 'chartreuse', density: 'spacious' },
      overlay: { crosshair: { size: 9999, opacity: 12, color: 'red', style: 'spiral' } }
    });
    expect(p.launcher.priority).toBe('normal');
    expect(p.launcher.affinityMask).toBeNull();
    expect(p.optimizer.preset).toBe('balanced');
    expect(p.appearance.accent).toBe('blossom');
    expect(p.appearance.density).toBe('comfortable');
    expect(p.overlay.crosshair.size).toBe(200);
    expect(p.overlay.crosshair.opacity).toBe(1);
    expect(p.overlay.crosshair.color).toBe('#ff5fa2');
    expect(p.overlay.crosshair.style).toBe('cross-dot');
  });

  it('never marks an imported profile as built in', () => {
    expect(coerceProfile({ builtIn: true, name: 'x' }).builtIn).toBe(false);
  });
});

describe('profile validation', () => {
  it('accepts a default profile', () => {
    const report = validateProfile(emptyProfile('x', 'X'));
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('reports an invalid flag value as an error, not a crash', () => {
    const p = emptyProfile('x', 'X');
    p.fastFlags = { DFIntTaskSchedulerTargetFps: 'fast' };
    const report = validateProfile(p);
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.path).toBe('fastFlags.DFIntTaskSchedulerTargetFps');
  });

  it('warns but stays valid for an unrecognised flag', () => {
    const p = emptyProfile('x', 'X');
    p.fastFlags = { FFlagSomethingBlossomHasNeverHeardOf: 'True' };
    const report = validateProfile(p);
    expect(report.valid).toBe(true);
    expect(report.issues[0]?.severity).toBe('warning');
  });

  it('rejects a profile written by a newer Blossom', () => {
    const p = { ...emptyProfile('x', 'X'), schemaVersion: 99 };
    expect(validateProfile(p).valid).toBe(false);
  });

  it('rejects launch arguments containing line breaks', () => {
    const p = emptyProfile('x', 'X');
    p.launcher.extraArgs = ['--fine', 'bad\nvalue'];
    expect(validateProfile(p).valid).toBe(false);
  });

  it('warns when interception is on with no rule sets selected', () => {
    const p = emptyProfile('x', 'X');
    p.assets.interception = true;
    const report = validateProfile(p);
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.path === 'assets.assetProfileIds')).toBe(true);
  });
});

describe('profile migration', () => {
  it('moves version 0 launcher fields into the launcher object', () => {
    const { raw, migratedFrom } = migrateProfile({ name: 'Old', multiInstance: true, priority: 'high' });
    expect(migratedFrom).toBe(0);
    const p = coerceProfile(raw, 'old');
    expect(p.launcher.multiInstance).toBe(true);
    expect(p.launcher.priority).toBe('high');
  });

  it('leaves a current profile untouched', () => {
    const current = emptyProfile('x', 'X');
    const { migratedFrom } = migrateProfile(current);
    expect(migratedFrom).toBeNull();
  });

  it('does not loop on a profile claiming a future version', () => {
    const { raw } = migrateProfile({ schemaVersion: 99, name: 'Future' });
    expect((raw as { schemaVersion: number }).schemaVersion).toBe(99);
  });
});
