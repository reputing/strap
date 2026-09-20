import { describe, expect, it } from 'vitest';
import { checkValue, isValidFlagName, normaliseValue, parseFlagName, valueTypeFor } from '@main/fastflags/flag-syntax';

describe('flag name parsing', () => {
  it('reads the longest matching prefix first', () => {
    expect(parseFlagName('DFFlagSomething')?.prefix).toBe('DFFlag');
    expect(parseFlagName('DFIntSomething')?.prefix).toBe('DFInt');
    expect(parseFlagName('FFlagSomething')?.prefix).toBe('FFlag');
    expect(parseFlagName('FIntSomething')?.prefix).toBe('FInt');
    expect(parseFlagName('SFStringSomething')?.prefix).toBe('SFString');
  });

  it('derives the value type from the prefix', () => {
    expect(valueTypeFor('FFlagX')).toBe('bool');
    expect(valueTypeFor('DFIntX')).toBe('int');
    expect(valueTypeFor('FStringX')).toBe('string');
    expect(valueTypeFor('NotAFlag')).toBe('unknown');
  });

  it('rejects names with no recognised prefix or a bare prefix', () => {
    expect(parseFlagName('Nonsense')).toBeNull();
    expect(parseFlagName('FFlag')).toBeNull();
    expect(parseFlagName('')).toBeNull();
  });

  it('rejects names containing punctuation', () => {
    expect(isValidFlagName('FFlagGood')).toBe(true);
    expect(isValidFlagName('FFlag Bad')).toBe(false);
    expect(isValidFlagName('FFlag-Bad')).toBe(false);
    expect(isValidFlagName('FFlagWith_Underscore')).toBe(true);
  });
});

describe('value checking', () => {
  it('accepts only True/False for boolean flags', () => {
    expect(checkValue('FFlagX', 'True').ok).toBe(true);
    expect(checkValue('FFlagX', 'false').ok).toBe(true);
    expect(checkValue('FFlagX', 'yes').ok).toBe(false);
    expect(checkValue('FFlagX', '1').ok).toBe(false);
  });

  it('accepts only whole numbers for integer flags', () => {
    expect(checkValue('DFIntX', '144').ok).toBe(true);
    expect(checkValue('DFIntX', '-5').ok).toBe(true);
    expect(checkValue('DFIntX', '1.5').ok).toBe(false);
    expect(checkValue('DFIntX', 'lots').ok).toBe(false);
    expect(checkValue('DFIntX', '999999999999999999999').ok).toBe(false);
  });

  it('rejects a value whose flag prefix is unknown', () => {
    const r = checkValue('Wibble', 'True');
    expect(r.ok).toBe(false);
  });
});

describe('normalisation', () => {
  it('canonicalises booleans to Roblox casing', () => {
    expect(normaliseValue('FFlagX', 'true')).toBe('True');
    expect(normaliseValue('FFlagX', 'FALSE')).toBe('False');
    expect(normaliseValue('FFlagX', '  True  ')).toBe('True');
  });

  it('truncates fractional integers rather than rejecting them here', () => {
    expect(normaliseValue('DFIntX', '144.9')).toBe('144');
    expect(normaliseValue('DFIntX', ' 60 ')).toBe('60');
  });

  it('leaves strings alone apart from trimming', () => {
    expect(normaliseValue('FStringX', '  hello  ')).toBe('hello');
  });
});
