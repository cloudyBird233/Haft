import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { containsPath } from '../src/repository-policy';

const absoluteA = join(tmpdir(), 'haft-allowed-a');
const absoluteB = join(tmpdir(), 'haft-allowed-b');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runner configuration', () => {
  it('reads the fake runner defaults without a project map', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_ID: 'runner_unit',
      HAFT_RUNNER_BOOTSTRAP_TOKEN: 'bootstrap-token-value',
      HAFT_RUNNER_STEP_MS: '50',
      HAFT_RUNNER_HEALTH_PORT: '3199',
    });
    expect(config).toMatchObject({
      runnerId: 'runner_unit',
      computerId: 'computer_local',
      mode: 'fake',
      stepMs: 50,
      healthPort: 3199,
      maxConcurrentExecutions: 1,
      fakeRuntimes: ['codex', 'opencode'],
      allowedRepositoryRoots: [],
      allowUnc: false,
    });
    expect(config.bootstrapToken).toBe('bootstrap-token-value');
    expect(config).not.toHaveProperty('projectPaths');
    expect(config.realRuntimes).toEqual(['codex', 'opencode']);
    expect(config.allowAutoApprove).toBe(false);
    expect(config.keepWorktrees).toBe(true);
    expect(config.worktreeRoot).toBe(resolve(config.worktreeRoot));
    expect(config.recoveryRoot).toBe(resolve(config.recoveryRoot));
  });

  it('accepts repeated --allowed-root flags and explicit UNC opt-in', () => {
    const config = loadConfig(
      [
        '--runner-id',
        'runner_cli',
        '--allowed-root',
        absoluteA,
        '--allowed-root',
        absoluteB,
        '--allow-unc',
        '--step-ms',
        '120',
      ],
      {},
    );
    expect(config.runnerId).toBe('runner_cli');
    expect(config.allowedRepositoryRoots).toEqual([normalize(absoluteA), normalize(absoluteB)]);
    expect(config.allowUnc).toBe(true);
    expect(config.stepMs).toBe(120);

    expect(() => loadConfig(['--step-ms', '1'], {})).toThrow(/step-ms/);
    expect(() => loadConfig(['--mode', 'shell'], {})).toThrow(/Unsupported runner mode/);
    expect(() => loadConfig(['--allowed-root', 'relative/repo'], {})).toThrow(
      /--allowed-root.*absolute/,
    );
  });

  it('reads allowed roots and UNC opt-in from the environment', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_ALLOWED_ROOTS: JSON.stringify([absoluteA, absoluteB]),
      HAFT_RUNNER_ALLOW_UNC: '1',
    });
    expect(config.allowedRepositoryRoots).toEqual([normalize(absoluteA), normalize(absoluteB)]);
    expect(config.allowUnc).toBe(true);

    const notOptedIn = loadConfig([], {
      HAFT_RUNNER_ALLOWED_ROOTS: JSON.stringify([absoluteA]),
      HAFT_RUNNER_ALLOW_UNC: 'true',
    });
    expect(notOptedIn.allowUnc).toBe(false);
  });

  it('rejects malformed allowed-root environment values', () => {
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: 'not-json' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: '{}' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: '[1]' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS\[0\]/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: '["relative"]' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS\[0\].*absolute/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: '[""]' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS\[0\].*absolute/,
    );
  });

  it('rejects the removed --project option', () => {
    expect(() => loadConfig(['--project', 'project_demo=D:/CODE/demo'], {})).toThrow(/--project/);
  });

  it('ignores legacy project environment variables', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_PROJECTS: JSON.stringify({ project_demo: absoluteA }),
      HAFT_RUNNER_PROJECT_ID: 'project_legacy',
      HAFT_RUNNER_WORKSPACE_ROOT: absoluteB,
    });
    expect(config.allowedRepositoryRoots).toEqual([]);
    expect(config).not.toHaveProperty('projectPaths');
    expect(JSON.stringify(config)).not.toContain('project_legacy');
  });

  it('warns exactly once that HAFT_RUNNER_PROJECTS is ignored', async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { loadConfig: freshLoadConfig } = await import('../src/config');
      const env = { HAFT_RUNNER_PROJECTS: JSON.stringify({ project_demo: absoluteA }) };
      const first = freshLoadConfig([], env);
      const second = freshLoadConfig([], env);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/no longer used/);
      expect(first).not.toHaveProperty('projectPaths');
      expect(second.allowedRepositoryRoots).toEqual([]);
    } finally {
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it('requires absolute worktree and recovery roots', () => {
    expect(() => loadConfig([], { HAFT_RUNNER_WORKTREE_ROOT: 'relative/worktrees' })).toThrow(
      /HAFT_RUNNER_WORKTREE_ROOT.*absolute/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_RECOVERY_ROOT: 'relative/recovery' })).toThrow(
      /HAFT_RUNNER_RECOVERY_ROOT.*absolute/,
    );
  });

  it('keeps the worktree and recovery roots disjoint by default', () => {
    const config = loadConfig([], {});
    expect(config.worktreeRoot).not.toBe(config.recoveryRoot);
    expect(containsPath(config.worktreeRoot, config.recoveryRoot, process.platform)).toBe(false);
    expect(containsPath(config.recoveryRoot, config.worktreeRoot, process.platform)).toBe(false);
  });

  it('defaults the fake runtime list to codex and opencode only', () => {
    const config = loadConfig([], {});
    expect(config.fakeRuntimes).toEqual(['codex', 'opencode']);
    expect(config.allowedRepositoryRoots).toEqual([]);
  });

  it('parses real CLI mode without enabling auto approval by default', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_MODE: 'real',
      HAFT_RUNNER_REAL_RUNTIMES: 'codex',
      HAFT_CODEX_BIN: 'C:/tools/codex.exe',
      HAFT_CODEX_MODEL: 'gpt-5-codex',
      HAFT_RUNNER_WORKTREE_ROOT: absoluteA,
      HAFT_RUNNER_CLI_TIMEOUT_MS: '120000',
    });
    expect(config.mode).toBe('real');
    expect(config.realRuntimes).toEqual(['codex']);
    expect(config.cliPaths.codex).toBe('C:/tools/codex.exe');
    expect(config.cliModels.codex).toBe('gpt-5-codex');
    expect(config.worktreeRoot).toBe(normalize(absoluteA));
    expect(config.cliTimeoutMs).toBe(120_000);
    expect(config.allowAutoApprove).toBe(false);
  });

  it('maps the legacy single-runtime modes to real mode', () => {
    const codex = loadConfig(['--mode', 'codex'], {});
    expect(codex.mode).toBe('real');
    expect(codex.realRuntimes).toEqual(['codex']);
    expect(codex.fakeRuntimes).toEqual(['codex', 'opencode']);

    const opencode = loadConfig(['--mode', 'opencode'], {});
    expect(opencode.mode).toBe('real');
    expect(opencode.realRuntimes).toEqual(['opencode']);
  });

  it('requires an explicit opt-in before auto approval is enabled', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_MODE: 'real',
      HAFT_RUNNER_ALLOW_AUTO_APPROVE: '1',
    });
    expect(config.allowAutoApprove).toBe(true);
  });
});
