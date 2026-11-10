import { describe, expect, it } from 'vitest';
import {
  createProjectBindingSchema,
  createProjectSchema,
  ERROR_CODES,
  PROJECT_BINDING_STATUSES,
  repositoryDefaultBranchSchema,
  repositoryPathSchema,
  updateProjectBindingSchema,
  updateProjectSchema,
} from '../src';

describe('project REST schemas', () => {
  it('normalises the key and applies safe defaults', () => {
    const parsed = createProjectSchema.parse({
      key: 'haft',
      name: 'Haft Platform',
    });
    expect(parsed.key).toBe('HAFT');
    expect(parsed.defaultBranch).toBe('main');
    expect(parsed.color).toBe('#6b7280');
    expect(parsed.description).toBe('');
  });

  it('rejects P2-02 project metadata such as repoUrl', () => {
    expect(
      createProjectSchema.safeParse({
        key: 'APP',
        name: 'App',
        repoUrl: 'git@github.com:org/app.git',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed keys and whitespace in default branches', () => {
    for (const key of ['1ABC', 'A', 'WITH SPACE', 'SYMBOL!']) {
      expect(createProjectSchema.safeParse({ key, name: 'App' }).success).toBe(false);
    }
    expect(
      createProjectSchema.safeParse({ key: 'APP', name: 'App', defaultBranch: 'release 1' })
        .success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ key: 'APP', name: 'App', defaultBranch: '../main' }).success,
    ).toBe(false);
    expect(repositoryDefaultBranchSchema.parse('release/2026')).toBe('release/2026');
  });

  it('requires at least one mutable field on update', () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(false);
    expect(updateProjectSchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
    expect(updateProjectSchema.parse({ archived: true })).toEqual({ archived: true });
    expect(updateProjectSchema.safeParse({ key: 'NEW' }).success).toBe(false);
  });
});

describe('project binding REST schemas', () => {
  it('keeps binding paths opaque to the API', () => {
    const path = String.raw`C:\Users\Dev\repos\haft`;
    expect(repositoryPathSchema.parse(path)).toBe(path);
    expect(repositoryPathSchema.parse('/srv/repos/haft with spaces')).toBe(
      '/srv/repos/haft with spaces',
    );
    expect(repositoryPathSchema.safeParse('').success).toBe(false);
    expect(repositoryPathSchema.safeParse('/srv/repo\0evil').success).toBe(false);
  });

  it('accepts only computerId and path when creating a binding', () => {
    expect(
      createProjectBindingSchema.parse({ computerId: 'computer_local', path: '/srv/repo' }),
    ).toEqual({ computerId: 'computer_local', path: '/srv/repo' });
    expect(
      createProjectBindingSchema.safeParse({
        computerId: 'computer_local',
        path: '/srv/repo',
        status: 'ready',
      }).success,
    ).toBe(false);
  });

  it('lets the controller classify immutable PATCH fields explicitly', () => {
    // The schema is intentionally permissive so the service can answer with
    // BINDING_FIELD_IMMUTABLE instead of a generic validation error.
    const parsed = updateProjectBindingSchema.parse({
      path: '/srv/repo',
      defaultBranch: 'release',
      status: 'ready',
    });
    expect(parsed).toMatchObject({ path: '/srv/repo', defaultBranch: 'release' });
  });

  it('freezes the four binding statuses and the P2-01 execution codes', () => {
    expect(PROJECT_BINDING_STATUSES).toEqual(['unverified', 'ready', 'missing', 'error']);
    expect(ERROR_CODES.PROJECT_BINDING_MISSING).toBe('PROJECT_BINDING_MISSING');
    expect(ERROR_CODES.PROJECT_BINDING_NOT_READY).toBe('PROJECT_BINDING_NOT_READY');
  });
});
