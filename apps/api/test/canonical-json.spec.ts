import { describe, expect, it } from 'vitest';
import { canonicalPayloadHash, canonicalizeJson } from '../src/common/canonical-json';

/**
 * P1-8: the canonical form must be stable across key order and must accept every
 * legal JSON number while rejecting everything JSON cannot represent.
 */
describe('canonicalizeJson', () => {
  it('is independent of key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: true, y: null } };
    const b = { c: { y: null, z: true }, a: 2, b: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
    expect(canonicalizeJson(a)).toBe('{"a":2,"b":1,"c":{"y":null,"z":true}}');
  });

  it('serialises arrays in order and preserves empty containers', () => {
    expect(canonicalizeJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalizeJson({ list: [], map: {} })).toBe('{"list":[],"map":{}}');
  });

  it('accepts every legal JSON number form', () => {
    expect(canonicalizeJson(0)).toBe('0');
    expect(canonicalizeJson(-0)).toBe('0');
    expect(canonicalizeJson(42)).toBe('42');
    expect(canonicalizeJson(-42)).toBe('-42');
    expect(canonicalizeJson(1.5)).toBe('1.5');
    expect(canonicalizeJson(0.1)).toBe('0.1');
    expect(canonicalizeJson(1e21)).toBe('1e+21');
    expect(canonicalizeJson(1e-7)).toBe('1e-7');
    expect(canonicalizeJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalizeJson(Number.MIN_VALUE)).toBe('5e-324');
  });

  it('rejects numbers JSON cannot represent', () => {
    expect(() => canonicalizeJson(Number.NaN)).toThrow(/NaN or Infinity/);
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(/NaN or Infinity/);
    expect(() => canonicalizeJson(Number.NEGATIVE_INFINITY)).toThrow(/NaN or Infinity/);
  });

  it('rejects values that would silently disappear', () => {
    expect(() => canonicalizeJson(undefined)).toThrow(/undefined/);
    expect(() => canonicalizeJson({ a: undefined })).toThrow(/undefined at "a"/);
    expect(() => canonicalizeJson([undefined])).toThrow(/sparse array/);
    expect(() => canonicalizeJson(() => 1)).toThrow(/function/);
    expect(() => canonicalizeJson(Symbol('x'))).toThrow(/symbol/);
    expect(() => canonicalizeJson(1n)).toThrow(/BigInt/);
  });

  it('rejects cyclic structures', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(/cyclic/);
  });

  it('serialises Date as ISO-8601 and rejects invalid dates', () => {
    expect(canonicalizeJson({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    );
    expect(() => canonicalizeJson(new Date('nope'))).toThrow(/invalid Date/);
  });

  it('escapes strings with JSON rules', () => {
    expect(canonicalizeJson({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}');
    expect(canonicalizeJson({ s: '中文' })).toBe('{"s":"中文"}');
  });
});

describe('canonicalPayloadHash', () => {
  it('produces a lowercase sha256 of the canonical string', () => {
    const hash = canonicalPayloadHash({ b: 1, a: 2 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(canonicalPayloadHash({ a: 2, b: 1 }));
  });

  it('changes when a nested value changes', () => {
    expect(canonicalPayloadHash({ a: [1, 2] })).not.toBe(canonicalPayloadHash({ a: [1, 3] }));
  });
});
