import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './logger';

interface TokenFile {
  runnerId: string;
  token: string;
  savedAt: string;
}

export class TokenStore {
  constructor(
    private readonly file: string,
    private readonly runnerId: string,
  ) {}

  async read(): Promise<string | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TokenFile>;
      if (parsed.runnerId !== this.runnerId || typeof parsed.token !== 'string') {
        return null;
      }
      return parsed.token;
    } catch (error) {
      if (isMissing(error)) return null;
      log('warn', {
        eventType: 'runner.token_read_failed',
        message: 'Could not read the cached runner token; pairing may be required',
      });
      return null;
    }
  }

  async write(token: string): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const payload: TokenFile = {
        runnerId: this.runnerId,
        token,
        savedAt: new Date().toISOString(),
      };
      await writeFile(this.file, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await chmod(this.file, 0o600).catch(() => undefined);
    } catch {
      log('warn', {
        eventType: 'runner.token_write_failed',
        message: 'Could not persist the issued runner token; it will only live in memory',
      });
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true }).catch(() => undefined);
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT',
  );
}
