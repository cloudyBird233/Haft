import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';

describe('runner configuration', () => {
  it('reads the fake runner defaults without exposing a token in logs', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_ID: 'runner_unit',
      HAFT_RUNNER_BOOTSTRAP_TOKEN: 'bootstrap-token-value',
      HAFT_RUNNER_PROJECTS: JSON.stringify({
        project_demo: 'C:/workspace/demo',
        project_other: 'C:/workspace/other',
      }),
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
    });
    expect(config.bootstrapToken).toBe('bootstrap-token-value');
    expect(config.projectPaths.project_demo).toBe(resolve('C:/workspace/demo'));
    expect(config.realRuntimes).toEqual(['codex', 'opencode']);
    expect(config.allowAutoApprove).toBe(false);
    expect(config.keepWorktrees).toBe(true);
  });

  it('accepts repeated --project flags and validates numeric bounds', () => {
    const config = loadConfig(
      [
        '--runner-id',
        'runner_cli',
        '--project',
        'project_demo=D:/CODE/demo',
        '--project',
        'project_two=D:/CODE/two',
        '--step-ms',
        '120',
      ],
      {},
    );
    expect(config.runnerId).toBe('runner_cli');
    expect(Object.keys(config.projectPaths)).toEqual(['project_demo', 'project_two']);
    expect(config.stepMs).toBe(120);

    expect(() => loadConfig(['--step-ms', '1'], {})).toThrow(/step-ms/);
    expect(() => loadConfig(['--mode', 'shell'], {})).toThrow(/Unsupported runner mode/);
  });

  it('parses allowed repository roots from env JSON and repeated CLI flags', () => {
    const fromEnv = loadConfig([], {
      HAFT_RUNNER_ALLOWED_ROOTS: JSON.stringify(['C:/repos', 'D:/work']),
    });
    expect(fromEnv.allowedRepositoryRoots).toEqual([resolve('C:/repos'), resolve('D:/work')]);

    const fromCli = loadConfig(
      ['--allowed-root', 'C:/repos/one', '--allowed-root', 'C:/repos/two'],
      {},
    );
    expect(fromCli.allowedRepositoryRoots).toEqual([
      resolve('C:/repos/one'),
      resolve('C:/repos/two'),
    ]);
    expect(loadConfig([], {}).allowedRepositoryRoots).toEqual([]);

    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: 'not json' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS/,
    );
    expect(() => loadConfig([], { HAFT_RUNNER_ALLOWED_ROOTS: '[]' })).toThrow(
      /HAFT_RUNNER_ALLOWED_ROOTS/,
    );
    expect(() => loadConfig(['--allowed-root', '  '], {})).toThrow(/allowed-root/);
  });

  it('defaults the fake runtime list to codex and opencode only', () => {
    const config = loadConfig([], {});
    expect(config.fakeRuntimes).toEqual(['codex', 'opencode']);
    expect(config.projectPaths.project_demo).toBeTruthy();
  });

  it('parses real CLI mode without enabling auto approval by default', () => {
    const config = loadConfig([], {
      HAFT_RUNNER_MODE: 'real',
      HAFT_RUNNER_REAL_RUNTIMES: 'codex',
      HAFT_CODEX_BIN: 'C:/tools/codex.exe',
      HAFT_CODEX_MODEL: 'gpt-5-codex',
      HAFT_RUNNER_WORKTREE_ROOT: 'C:/haft-worktrees',
      HAFT_RUNNER_CLI_TIMEOUT_MS: '120000',
    });
    expect(config.mode).toBe('real');
    expect(config.realRuntimes).toEqual(['codex']);
    expect(config.cliPaths.codex).toBe('C:/tools/codex.exe');
    expect(config.cliModels.codex).toBe('gpt-5-codex');
    expect(config.worktreeRoot).toBe(resolve('C:/haft-worktrees'));
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
