export interface RunnerLogEntry {
  eventType: string;
  message: string;
  status?: string;
  executionId?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Structured single-line logs. Never pass tokens or full prompts here; the
 * runner keeps secrets out of both stdout and persisted execution logs.
 */
export function log(level: 'info' | 'warn' | 'error', entry: RunnerLogEntry): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    ...entry,
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
