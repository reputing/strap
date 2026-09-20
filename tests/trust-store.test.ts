import { describe, expect, it } from 'vitest';
import { block, stripBlock, CA_BLOCK_MARKERS } from '@main/interception/trust-store';

const CERT = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const ORIGINAL = '# Roblox bundle\n-----BEGIN CERTIFICATE-----\nZZZZ\n-----END CERTIFICATE-----\n';

describe('certificate bundle editing', () => {
  it('fences the block so removal is exact', () => {
    const b = block(CERT);
    expect(b.startsWith(CA_BLOCK_MARKERS.BEGIN)).toBe(true);
    expect(b.trimEnd().endsWith(CA_BLOCK_MARKERS.END)).toBe(true);
  });

  it('round-trips to the original bytes', () => {
    const withBlock = ORIGINAL + block(CERT);
    expect(stripBlock(withBlock)).toBe(ORIGINAL);
  });

  it('leaves a bundle without a block untouched', () => {
    expect(stripBlock(ORIGINAL)).toBe(ORIGINAL);
  });

  it('removes several blocks left by repeated installs', () => {
    const messy = ORIGINAL + block(CERT) + block(CERT) + block(CERT);
    expect(stripBlock(messy)).toBe(ORIGINAL);
  });

  it('removes a truncated block rather than leaving half of one behind', () => {
    const truncated = ORIGINAL + CA_BLOCK_MARKERS.BEGIN + '\n-----BEGIN CERTIFICATE-----\npartial';
    expect(stripBlock(truncated)).toBe(ORIGINAL);
  });

  it('never removes a certificate Roblox shipped', () => {
    const result = stripBlock(ORIGINAL + block(CERT));
    expect(result).toContain('ZZZZ');
    expect(result).not.toContain('AAAA');
  });
});
