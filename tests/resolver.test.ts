import { describe, expect, it } from 'vitest';
import { globToRegExp, matches, resolve, sortRules } from '@main/assets/resolver';
import type { AssetRule } from '@shared/types';

let seq = 0;
function rule(patch: Partial<AssetRule> = {}): AssetRule {
  seq += 1;
  return {
    id: `r${seq}`, setId: 's1', source: '123', action: 'replace-asset', target: '456',
    assetType: 'image', enabled: true, priority: 0, notes: '',
    createdAt: seq, updatedAt: seq, hits: 0, ...patch
  };
}

const req = (assetId: string | null, url = 'https://c0.rbxcdn.com/abc') => ({ assetId, url });

describe('rule matching', () => {
  it('matches an exact numeric asset id', () => {
    expect(matches(rule({ source: '123' }), req('123'))).toBe(true);
    expect(matches(rule({ source: '123' }), req('124'))).toBe(false);
    expect(matches(rule({ source: '123' }), req(null))).toBe(false);
  });

  it('matches a glob against the request url', () => {
    const r = rule({ source: '*rbxcdn.com/*' });
    expect(matches(r, req(null, 'https://c0.rbxcdn.com/deadbeef'))).toBe(true);
    expect(matches(r, req(null, 'https://example.com/x'))).toBe(false);
  });

  it('treats a plain string source as a url substring', () => {
    expect(matches(rule({ source: 'deadbeef' }), req(null, 'https://c0.rbxcdn.com/deadbeef'))).toBe(true);
    expect(matches(rule({ source: 'deadbeef' }), req(null, 'https://c0.rbxcdn.com/other'))).toBe(false);
  });

  it('ignores an empty source', () => {
    expect(matches(rule({ source: '   ' }), req('123'))).toBe(false);
  });

  it('escapes regex metacharacters in globs', () => {
    const re = globToRegExp('a+b(c).d*');
    expect(re.test('a+b(c).dXYZ')).toBe(true);
    expect(re.test('aab(c)_dXYZ')).toBe(false);
  });
});

describe('resolution', () => {
  it('passes through when nothing matches', () => {
    const r = resolve(req('999'), [rule({ source: '123' })]);
    expect(r.kind).toBe('passthrough');
  });

  it('takes the highest priority matching rule', () => {
    const low = rule({ source: '123', target: '111', priority: 1 });
    const high = rule({ source: '123', target: '222', priority: 9 });
    const r = resolve(req('123'), sortRules([low, high]));
    expect(r.kind).toBe('replace-asset');
    if (r.kind === 'replace-asset') expect(r.targetAssetId).toBe('222');
  });

  it('breaks priority ties on creation order', () => {
    const first = rule({ source: '123', target: '111', priority: 5, createdAt: 1 });
    const second = rule({ source: '123', target: '222', priority: 5, createdAt: 2 });
    const r = resolve(req('123'), sortRules([second, first]));
    if (r.kind === 'replace-asset') expect(r.targetAssetId).toBe('111');
  });

  it('skips disabled rules', () => {
    const r = resolve(req('123'), [rule({ source: '123', enabled: false })]);
    expect(r.kind).toBe('passthrough');
  });

  it('never fails a request because a rule is malformed', () => {
    for (const bad of [
      rule({ source: '123', action: 'replace-asset', target: 'not-a-number' }),
      rule({ source: '123', action: 'replace-asset', target: '123' }),
      rule({ source: '123', action: 'replace-file', target: '   ' }),
      rule({ source: '123', action: 'replace-url', target: 'http://insecure.example' }),
      rule({ source: '123', action: 'replace-url', target: 'javascript:alert(1)' })
    ]) {
      const r = resolve(req('123'), [bad]);
      expect(r.kind).toBe('passthrough');
    }
  });

  it('honours remove and explicit passthrough', () => {
    expect(resolve(req('123'), [rule({ source: '123', action: 'remove' })]).kind).toBe('remove');
    expect(resolve(req('123'), [rule({ source: '123', action: 'passthrough' })]).kind).toBe('passthrough');
  });

  it('accepts a valid https replacement url', () => {
    const r = resolve(req('123'), [rule({ source: '123', action: 'replace-url', target: 'https://example.com/a.png' })]);
    expect(r.kind).toBe('replace-url');
  });

  it('an explicit passthrough rule shadows a lower-priority replacement', () => {
    const allow = rule({ source: '123', action: 'passthrough', priority: 10 });
    const replace = rule({ source: '123', action: 'replace-asset', target: '456', priority: 1 });
    expect(resolve(req('123'), sortRules([replace, allow])).kind).toBe('passthrough');
  });
});
