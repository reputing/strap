import { describe, expect, it } from 'vitest';
import { bestScore, COMMANDS, SearchService } from '@main/search/search-service';

const service = new SearchService({
  profiles: () => [{ id: 'competitive', name: 'Competitive', description: 'Frame consistency first' }],
  ruleSets: () => [{ id: 'set1', name: 'Low Texture', description: 'Flat replacement textures' }],
  activeFlags: () => ({ DFIntTaskSchedulerTargetFps: '240' })
});

describe('scoring', () => {
  it('ranks exact over prefix over word-boundary over substring', () => {
    expect(bestScore('cache', ['cache'])).toBeGreaterThan(bestScore('cache', ['cache browser']));
    expect(bestScore('cache', ['cache browser'])).toBeGreaterThan(bestScore('cache', ['the cache browser']));
    expect(bestScore('cache', ['the cache browser'])).toBeGreaterThan(bestScore('cache', ['uncached']));
  });

  it('returns zero when nothing matches', () => {
    expect(bestScore('zzz', ['cache', 'assets'])).toBe(0);
  });

  it('treats regex characters in the term literally', () => {
    expect(() => bestScore('a+b(', ['whatever'])).not.toThrow();
    expect(bestScore('a+b(', ['a+b('])).toBeGreaterThan(0);
  });
});

describe('global search', () => {
  it('surfaces every kind for a broad term', () => {
    const hits = service.query('texture');
    const kinds = new Set(hits.map((h) => h.kind));
    expect(hits.length).toBeGreaterThan(3);
    expect(kinds.has('page')).toBe(true);
    expect(kinds.has('asset')).toBe(true);
  });

  it('finds a profile by name', () => {
    const hits = service.query('competitive');
    expect(hits[0]?.kind).toBe('profile');
    expect(hits[0]?.route).toContain('competitive');
  });

  it('finds a flag by name and shows its current value', () => {
    const hit = service.query('TaskSchedulerTargetFps').find((h) => h.kind === 'flag');
    expect(hit).toBeDefined();
    expect(hit?.subtitle).toContain('240');
  });

  it('finds commands', () => {
    const hit = service.query('crosshair').find((h) => h.kind === 'command');
    expect(hit?.id).toBe('overlay.toggle-crosshair');
  });

  it('returns nothing for an empty term', () => {
    expect(service.query('')).toEqual([]);
    expect(service.query('   ')).toEqual([]);
  });

  it('caps the result count', () => {
    expect(service.query('a').length).toBeLessThanOrEqual(40);
  });

  it('is sorted by descending score', () => {
    const hits = service.query('cache');
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });
});

describe('command palette', () => {
  it('has unique ids and a group for every command', () => {
    const ids = new Set<string>();
    for (const command of COMMANDS) {
      expect(ids.has(command.id), command.id).toBe(false);
      ids.add(command.id);
      expect(command.group.length).toBeGreaterThan(0);
      expect(command.title.length).toBeGreaterThan(0);
    }
  });
});
