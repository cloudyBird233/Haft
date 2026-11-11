import { createHash } from 'node:crypto';
import type { RepositoryValidatePayload, RepositoryValidationPayload } from '@raft-lite/contracts';

export const REPOSITORY_VALIDATION_CACHE_TTL_MS = 5 * 60_000;
export const REPOSITORY_VALIDATION_CACHE_MAX_ENTRIES = 500;

export type RepositoryValidationCacheLookup =
  | { status: 'miss' }
  | { status: 'hit'; payload: RepositoryValidationPayload }
  | { status: 'conflict' };

interface CacheEntry {
  payloadHash: string;
  response: RepositoryValidationPayload;
  storedAt: number;
}

/**
 * Deterministic identity of a validation payload. `requestId` is deliberately
 * excluded: the cache is keyed by it, and the remainder is what decides whether
 * a replay is genuine or a payload-conflict.
 */
export function repositoryValidationPayloadHash(payload: RepositoryValidatePayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        projectId: payload.projectId,
        computerId: payload.computerId,
        bindingId: payload.bindingId,
        bindingVersion: payload.bindingVersion,
        path: payload.path,
      }),
    )
    .digest('hex');
}

/**
 * Bounded, in-memory replay cache for `repository.validate`.
 *
 * The same requestId with the same payload replays the stored
 * `repository.validation` payload (the caller is responsible for wrapping it in
 * a new envelope). The same requestId with a different payload is rejected
 * instead of overwriting the original result. Entries expire after five
 * minutes and the map never grows beyond the configured capacity.
 */
export class RepositoryValidationCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number = REPOSITORY_VALIDATION_CACHE_TTL_MS,
    private readonly maxEntries: number = REPOSITORY_VALIDATION_CACHE_MAX_ENTRIES,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('RepositoryValidationCache maxEntries must be a positive integer');
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get(requestId: string, payloadHash: string): RepositoryValidationCacheLookup {
    this.pruneExpired();
    const entry = this.entries.get(requestId);
    if (!entry) {
      return { status: 'miss' };
    }
    if (entry.payloadHash !== payloadHash) {
      return { status: 'conflict' };
    }
    return { status: 'hit', payload: entry.response };
  }

  set(requestId: string, payloadHash: string, response: RepositoryValidationPayload): void {
    this.pruneExpired();
    const existing = this.entries.get(requestId);
    if (existing) {
      // Never overwrite a first result with a different payload. Callers check
      // for the conflict before validating, so this is a defensive guard.
      if (existing.payloadHash !== payloadHash) {
        return;
      }
      existing.response = response;
      existing.storedAt = this.now();
      return;
    }
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.entries.delete(oldest);
    }
    this.entries.set(requestId, {
      payloadHash,
      response,
      storedAt: this.now(),
    });
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [requestId, entry] of this.entries) {
      if (now - entry.storedAt >= this.ttlMs) {
        this.entries.delete(requestId);
      }
    }
  }
}
