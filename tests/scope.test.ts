import { describe, expect, it } from 'vitest';
import { inScope, isAllowedScopeEntry, portFrom, sanitiseScope, stripPort } from '@main/interception/scope';
import { DEFAULT_INTERCEPTION_SCOPE } from '@main/core/defaults';

describe('scope enforcement', () => {
  it('accepts the shipped asset hosts', () => {
    for (const host of DEFAULT_INTERCEPTION_SCOPE) {
      expect(isAllowedScopeEntry(host)).toBe(true);
    }
  });

  it('refuses authentication, account and payment hosts even if configured', () => {
    for (const host of [
      'auth.roblox.com', 'apis.roblox.com', 'economy.roblox.com', 'billing.roblox.com',
      'users.roblox.com', 'www.roblox.com', 'accountsettings.roblox.com',
      'twostepverification.roblox.com', 'gamejoin.roblox.com'
    ]) {
      expect(isAllowedScopeEntry(host)).toBe(false);
      expect(inScope(host, [host])).toBe(false);
    }
  });

  it('refuses hosts that are not Roblox at all', () => {
    for (const host of ['example.com', 'google.com', 'localhost', 'my-bank.co.uk']) {
      expect(isAllowedScopeEntry(host)).toBe(false);
    }
  });

  it('refuses wildcards and the roblox.com apex, which would opt the user into everything', () => {
    expect(isAllowedScopeEntry('*')).toBe(false);
    expect(isAllowedScopeEntry('*.roblox.com')).toBe(false);
    expect(isAllowedScopeEntry('*.rbxcdn.com')).toBe(false);
    expect(isAllowedScopeEntry('roblox.com')).toBe(false);
  });

  it('matches on dot boundaries, never substrings', () => {
    const scope = ['rbxcdn.com'];
    expect(inScope('c0.rbxcdn.com', scope)).toBe(true);
    expect(inScope('rbxcdn.com', scope)).toBe(true);
    expect(inScope('evil-rbxcdn.com', scope)).toBe(false);
    expect(inScope('rbxcdn.com.evil.net', scope)).toBe(false);
  });

  it('ignores the port when matching', () => {
    expect(inScope('c0.rbxcdn.com:443', ['c0.rbxcdn.com'])).toBe(true);
    expect(stripPort('c0.rbxcdn.com:443')).toBe('c0.rbxcdn.com');
    expect(portFrom('c0.rbxcdn.com:8443')).toBe(8443);
    expect(portFrom('c0.rbxcdn.com')).toBe(443);
  });

  it('drops forbidden and malformed entries when sanitising', () => {
    const cleaned = sanitiseScope([
      'c0.rbxcdn.com', 'AUTH.ROBLOX.COM', '', '   ', 'bad host', 'c0.rbxcdn.com', '*', 'roblox.com'
    ]);
    expect(cleaned).toEqual(['c0.rbxcdn.com']);
  });

  it('never decrypts a host absent from the configured scope', () => {
    expect(inScope('c9.rbxcdn.com', ['c0.rbxcdn.com'])).toBe(false);
    expect(inScope('c0.rbxcdn.com', [])).toBe(false);
  });
});
