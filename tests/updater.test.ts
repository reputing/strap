import { describe, expect, it } from 'vitest';
import { compareVersions, parseManifest } from '@main/updater/update-service';

const valid = {
  version: '1.2.3',
  channel: 'stable',
  notes: 'Fixes',
  url: 'https://example.com/blossom-1.2.3.pkg',
  sha256: 'a'.repeat(64),
  sizeBytes: 1024,
  publishedAt: '2026-01-01T00:00:00Z'
};

describe('release manifest validation', () => {
  it('accepts a well-formed manifest', () => {
    const r = parseManifest(valid, 'stable');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.version).toBe('1.2.3');
  });

  it('refuses a manifest with no checksum', () => {
    for (const sha256 of [undefined, '', 'short', 'z'.repeat(64)]) {
      const r = parseManifest({ ...valid, sha256 }, 'stable');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('validation-failed');
    }
  });

  it('refuses a download that is not https', () => {
    for (const url of ['http://example.com/x.pkg', 'file:///tmp/x', 'ftp://example.com/x']) {
      expect(parseManifest({ ...valid, url }, 'stable').ok).toBe(false);
    }
  });

  it('refuses a preview build offered on the stable channel', () => {
    const r = parseManifest({ ...valid, channel: 'preview' }, 'stable');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/preview build for the stable channel/);
  });

  it('refuses a manifest with no usable version', () => {
    for (const version of [undefined, '', 'latest', 'v-next']) {
      expect(parseManifest({ ...valid, version }, 'stable').ok).toBe(false);
    }
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, 'nope', 42, undefined]) {
      expect(parseManifest(raw, 'stable').ok).toBe(false);
    }
  });
});

describe('version comparison', () => {
  it('orders numerically across every component', () => {
    expect(compareVersions('1.2.3', '1.2.2')).toBe(1);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('does not consider a build suffix an upgrade on its own', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
});
