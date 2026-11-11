import { describe, expect, it } from 'vitest';
import type { RepositoryValidatePayload, RepositoryValidationPayload } from '@raft-lite/contracts';
import {
  REPOSITORY_VALIDATION_CACHE_MAX_ENTRIES,
  REPOSITORY_VALIDATION_CACHE_TTL_MS,
  RepositoryValidationCache,
  repositoryValidationPayloadHash,
} from '../src/repository-validation-cache';

function request(overrides: Partial<RepositoryValidatePayload> = {}): RepositoryValidatePayload {
  return {
    requestId: 'request-1',
    projectId: 'project_demo',
    computerId: 'computer_local',
    bindingId: 'binding-1',
    bindingVersion: 1,
    path: '/repos/demo',
    ...overrides,
  };
}

function response(
  overrides: Partial<RepositoryValidationPayload> = {},
): RepositoryValidationPayload {
  return {
    requestId: 'request-1',
    projectId: 'project_demo',
    computerId: 'computer_local',
    bindingId: 'binding-1',
    bindingVersion: 1,
    ok: true,
    platform: 'linux',
    policyVersion: 'policy-1',
    canonicalPath: '/repos/demo',
    headCommit: 'a'.repeat(40),
    ...overrides,
  };
}

describe('RepositoryValidationCache', () => {
  it('replays the same requestId + payload without re-running validation', () => {
    const cache = new RepositoryValidationCache();
    const payload = request();
    const hash = repositoryValidationPayloadHash(payload);
    const result = response();
    cache.set(payload.requestId, hash, result);

    const lookup = cache.get(payload.requestId, hash);
    expect(lookup).toEqual({ status: 'hit', payload: result });
  });

  it('rejects the same requestId with a different payload', () => {
    const cache = new RepositoryValidationCache();
    const original = request();
    const changed = request({ path: '/repos/other' });
    cache.set(original.requestId, repositoryValidationPayloadHash(original), response());

    const lookup = cache.get(changed.requestId, repositoryValidationPayloadHash(changed));
    expect(lookup).toEqual({ status: 'conflict' });
    // The original result must not be overwritten.
    expect(cache.get(original.requestId, repositoryValidationPayloadHash(original))).toMatchObject({
      status: 'hit',
    });
  });

  it('treats a different requestId as an independent validation', () => {
    const cache = new RepositoryValidationCache();
    const first = request({ requestId: 'request-1' });
    const second = request({ requestId: 'request-2', bindingVersion: 2 });
    cache.set(first.requestId, repositoryValidationPayloadHash(first), response());
    expect(cache.get(second.requestId, repositoryValidationPayloadHash(second))).toEqual({
      status: 'miss',
    });
  });

  it('expires entries after the five-minute TTL', () => {
    let now = 0;
    const cache = new RepositoryValidationCache(REPOSITORY_VALIDATION_CACHE_TTL_MS, 500, () => now);
    const payload = request();
    const hash = repositoryValidationPayloadHash(payload);
    cache.set(payload.requestId, hash, response());

    now = REPOSITORY_VALIDATION_CACHE_TTL_MS - 1;
    expect(cache.get(payload.requestId, hash).status).toBe('hit');

    now = REPOSITORY_VALIDATION_CACHE_TTL_MS;
    expect(cache.get(payload.requestId, hash).status).toBe('miss');
    expect(cache.size).toBe(0);
  });

  it('evicts the oldest entry when the capacity limit is reached', () => {
    const cache = new RepositoryValidationCache(REPOSITORY_VALIDATION_CACHE_TTL_MS, 2);
    for (const requestId of ['request-1', 'request-2', 'request-3']) {
      const payload = request({ requestId });
      cache.set(requestId, repositoryValidationPayloadHash(payload), response({ requestId }));
    }
    expect(cache.size).toBe(2);
    expect(cache.get('request-1', repositoryValidationPayloadHash(request())).status).toBe('miss');
    expect(
      cache.get('request-2', repositoryValidationPayloadHash(request({ requestId: 'request-2' })))
        .status,
    ).toBe('hit');
    expect(
      cache.get('request-3', repositoryValidationPayloadHash(request({ requestId: 'request-3' })))
        .status,
    ).toBe('hit');
  });

  it('has a bounded production default', () => {
    expect(REPOSITORY_VALIDATION_CACHE_TTL_MS).toBe(5 * 60_000);
    expect(REPOSITORY_VALIDATION_CACHE_MAX_ENTRIES).toBe(500);
  });
});
