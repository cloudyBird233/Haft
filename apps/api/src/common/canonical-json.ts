import { createHash } from 'node:crypto';

/**
 * Canonical JSON serializer for the durable handshake message evidence.
 *
 * The rules are a strict subset of RFC 8785 (JCS) that is sufficient for the
 * runner protocol envelopes:
 *
 *   * object keys are sorted by UTF-16 code units;
 *   * numbers use the ECMAScript `Number::toString` form, which is what
 *     `JSON.stringify` already emits, so `1`, `1.5`, `1e+21` and `1e-7` are
 *     preserved exactly as JavaScript serialises them;
 *   * `-0` is normalised to `0` (JCS requires it; `JSON.stringify` would emit
 *     `0` anyway, but an explicit check keeps the rule documented);
 *   * strings are escaped by `JSON.stringify`, which matches the JCS escaping
 *     rules for the characters the protocol can carry;
 *   * `Date` values are serialised as ISO-8601 strings.
 *
 * Anything that cannot be represented unambiguously is rejected instead of
 * silently dropped: `undefined`, functions, symbols, `BigInt`, `NaN` and
 * `Infinity`. A payload that would hash differently depending on insertion
 * order or on which runtime produced it must never reach the database.
 */
export function canonicalizeJson(value: unknown): string {
  return serialize(value, new Set<object>());
}

/** Canonical payload hash: lowercase hex SHA-256 of the canonical JSON. */
export function canonicalPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'object':
      return serializeObject(value as Record<string, unknown> | unknown[], seen);
    case 'undefined':
      throw new TypeError('canonical JSON cannot represent undefined');
    case 'bigint':
      throw new TypeError('canonical JSON cannot represent a BigInt');
    case 'function':
      throw new TypeError('canonical JSON cannot represent a function');
    case 'symbol':
      throw new TypeError('canonical JSON cannot represent a symbol');
    default:
      throw new TypeError(`canonical JSON cannot represent a ${typeof value}`);
  }
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError('canonical JSON cannot represent NaN or Infinity');
  }
  if (Object.is(value, -0)) return '0';
  return JSON.stringify(value);
}

function serializeObject(value: Record<string, unknown> | unknown[], seen: Set<object>): string {
  if (seen.has(value)) {
    throw new TypeError('canonical JSON cannot represent a cyclic structure');
  }
  seen.add(value);
  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError('canonical JSON cannot represent an invalid Date');
      }
      return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item === undefined) {
          throw new TypeError('canonical JSON cannot represent a sparse array entry');
        }
        return serialize(item, seen);
      });
      return `[${items.join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const item = record[key];
      // A missing key and a key whose value is `undefined` must never produce
      // the same hash, so `undefined` is rejected rather than omitted.
      if (item === undefined) {
        throw new TypeError(`canonical JSON cannot represent undefined at "${key}"`);
      }
      entries.push(`${JSON.stringify(key)}:${serialize(item, seen)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
