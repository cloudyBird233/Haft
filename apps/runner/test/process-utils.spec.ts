import { describe, expect, it } from 'vitest';
import { buildCliEnvironment, resolveExecutable } from '../src/process-utils';

describe('runner process helpers', () => {
  it('strips runner secrets from the CLI environment', () => {
    const env = buildCliEnvironment({
      PATH: 'C:/tools',
      HOME: 'C:/Users/example',
      HAFT_RUNNER_BOOTSTRAP_TOKEN: 'bootstrap-secret',
      HAFT_RUNNER_TOKEN_FILE: 'C:/secret/token.json',
      E2E_RUNNER_BOOTSTRAP_TOKEN: 'e2e-secret',
    });
    expect(env.PATH).toBe('C:/tools');
    expect(env.HOME).toBe('C:/Users/example');
    expect(env.NO_COLOR).toBe('1');
    expect(Object.keys(env).some((key) => key.startsWith('HAFT_'))).toBe(false);
    expect(Object.keys(env).some((key) => key.startsWith('E2E_RUNNER_'))).toBe(false);
    expect(JSON.stringify(env)).not.toContain('bootstrap-secret');
  });

  it('resolves an executable from PATH without a shell', async () => {
    const result = await resolveExecutable(process.platform === 'win32' ? 'node.exe' : 'node');
    expect(result.path).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it('reports missing explicit executables with an actionable error', async () => {
    const result = await resolveExecutable('C:/definitely/not/here/haft-missing-cli');
    expect(result.path).toBeNull();
    expect(result.error).toContain('was not found');
  });
});
