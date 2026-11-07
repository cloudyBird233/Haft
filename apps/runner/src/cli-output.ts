import type { LogLevel, LogStream, RunnerRuntimeType } from '@raft-lite/contracts';

/**
 * Converts codex/opencode output into bounded runner log lines.
 *
 * Both CLIs support JSONL output. Unknown events are ignored rather than
 * rendered raw so a CLI upgrade cannot dump an unstructured payload into the
 * database. Non-JSON lines are still preserved (stderr diagnostics, warnings).
 */

export interface CliLogLine {
  stream: LogStream;
  level: LogLevel;
  message: string;
}

export interface CliOutputParser {
  push(chunk: string, stream: 'stdout' | 'stderr'): CliLogLine[];
  flush(): CliLogLine[];
  lastSummary(): string | null;
  lastError(): string | null;
}

const MAX_LINE_LENGTH = 8000;
const MAX_BUFFER_LENGTH = 64_000;
const MAX_SUMMARY_LENGTH = 20_000;

export function createCliOutputParser(runtime: RunnerRuntimeType): CliOutputParser {
  return runtime === 'codex' ? new CodexOutputParser() : new OpencodeOutputParser();
}

abstract class BaseParser implements CliOutputParser {
  private buffer = '';
  private summary: string | null = null;
  private errorText: string | null = null;

  push(chunk: string, stream: 'stdout' | 'stderr'): CliLogLine[] {
    this.buffer += chunk;
    const lines: CliLogLine[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      lines.push(...this.parseLine(raw.replace(/\r$/, ''), stream));
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_BUFFER_LENGTH) {
      const raw = this.buffer;
      this.buffer = '';
      lines.push(...this.parseLine(raw, stream));
    }
    return lines;
  }

  flush(): CliLogLine[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }
    const raw = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    return this.parseLine(raw, 'stdout');
  }

  lastSummary(): string | null {
    return this.summary;
  }

  lastError(): string | null {
    return this.errorText;
  }

  protected recordSummary(text: string): void {
    const normalized = stripAnsi(text).trim();
    if (!normalized) return;
    this.summary = normalized.slice(0, MAX_SUMMARY_LENGTH);
  }

  protected recordError(text: string): void {
    const normalized = stripAnsi(text).trim();
    if (!normalized) return;
    this.errorText = normalized.slice(0, 2000);
  }

  protected rawLines(raw: string, stream: 'stdout' | 'stderr'): CliLogLine[] {
    return textLines(
      raw,
      stream,
      stream === 'stderr' ? 'warning' : 'info',
    );
  }

  protected line(
    stream: LogStream,
    level: LogLevel,
    message: string,
  ): CliLogLine {
    return {
      stream,
      level,
      message: limit(redact(stripAnsi(message))),
    };
  }

  protected abstract parseLine(raw: string, stream: 'stdout' | 'stderr'): CliLogLine[];
}

class CodexOutputParser extends BaseParser {
  protected parseLine(raw: string, stream: 'stdout' | 'stderr'): CliLogLine[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (/^Reading additional input from stdin\.?$/i.test(trimmed)) {
      return [this.line('system', 'info', 'Codex is reading the task prompt from stdin.')];
    }

    const event = parseJsonObject(trimmed);
    if (!event) {
      return this.rawLines(trimmed, stream);
    }

    const type = stringValue(event.type);
    switch (type) {
      case 'thread.started':
        return [this.line('system', 'info', 'Codex thread started.')];
      case 'turn.started':
        return [this.line('system', 'info', 'Codex turn started.')];
      case 'turn.completed':
        return [this.line('system', 'success', 'Codex turn completed.')];
      case 'turn.failed': {
        const message = extractError(event);
        this.recordError(message);
        return [this.line('stderr', 'error', `Codex turn failed: ${message}`)];
      }
      case 'error': {
        const message = extractError(event);
        this.recordError(message);
        return [this.line('stderr', 'error', `Codex error: ${message}`)];
      }
      case 'item.started':
      case 'item.completed':
        return this.parseItem(event, type === 'item.completed');
      default:
        return [];
    }
  }

  private parseItem(event: Record<string, unknown>, completed: boolean): CliLogLine[] {
    const item = asObject(event.item);
    if (!item) return [];
    const type = stringValue(item.type);

    if (type === 'agent_message') {
      if (!completed) return [];
      const text = stringValue(item.text);
      if (!text.trim()) return [];
      this.recordSummary(text);
      return textLines(text, 'stdout', 'info').map((line) => ({
        ...line,
        message: limit(redact(line.message)),
      }));
    }

    if (type === 'reasoning') {
      if (!completed) return [];
      const text = stringValue(item.text);
      if (!text.trim()) return [];
      return [this.line('system', 'info', `Reasoning: ${truncate(text, 1200)}`)];
    }

    if (type === 'command_execution') {
      const command = stringValue(item.command);
      if (!completed) {
        return command ? [this.line('system', 'info', `$ ${truncate(command, 1500)}`)] : [];
      }
      const lines: CliLogLine[] = [];
      const output = stringValue(item.aggregated_output) || stringValue(item.output);
      if (output.trim()) {
        lines.push(...textLines(output, 'stdout', 'info'));
      }
      const exitCode = numberValue(item.exit_code);
      if (exitCode !== null && exitCode !== 0) {
        const message = `Command exited with code ${exitCode}.`;
        this.recordError(message);
        lines.push(this.line('stderr', 'error', message));
      }
      return lines;
    }

    if (type === 'file_change') {
      if (!completed) return [];
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const lines: CliLogLine[] = [];
      for (const rawChange of changes) {
        const change = asObject(rawChange);
        if (!change) continue;
        const path = stringValue(change.path);
        const kind = stringValue(change.kind);
        if (path) {
          lines.push(
            this.line(
              'system',
              'success',
              `File change: ${path}${kind ? ` (${kind})` : ''}`,
            ),
          );
        }
      }
      return lines;
    }

    if (type === 'error') {
      const message = extractError(item);
      this.recordError(message);
      return [this.line('stderr', 'error', `Codex error: ${message}`)];
    }

    return [];
  }
}

class OpencodeOutputParser extends BaseParser {
  protected parseLine(raw: string, stream: 'stdout' | 'stderr'): CliLogLine[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const event = parseJsonObject(trimmed);
    if (!event) {
      return this.rawLines(trimmed, stream);
    }

    const type = stringValue(event.type);
    const part = asObject(event.part);

    switch (type) {
      case 'step_start':
        return [];
      case 'text': {
        const text = stringValue(part?.text);
        if (!text.trim()) return [];
        this.recordSummary(text);
        return textLines(text, 'stdout', 'info');
      }
      case 'tool': {
        const tool = stringValue(part?.tool) || 'tool';
        const state = asObject(part?.state);
        const status = stringValue(state?.status);
        const title = stringValue(state?.title);
        return [
          this.line(
            'system',
            'info',
            `Tool ${tool}${status ? ` (${status})` : ''}${title ? `: ${truncate(title, 500)}` : ''}`,
          ),
        ];
      }
      case 'step_finish': {
        const reason = stringValue(part?.reason);
        return [
          this.line(
            'system',
            'success',
            `OpenCode step finished${reason ? `: ${reason}` : ''}.`,
          ),
        ];
      }
      case 'error': {
        const message = extractError(event);
        this.recordError(message);
        return [this.line('stderr', 'error', `OpenCode error: ${message}`)];
      }
      default:
        return [];
    }
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith('{')) return null;
  try {
    return asObject(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function extractError(event: Record<string, unknown>): string {
  const direct = stringValue(event.message);
  if (direct) return truncate(direct, 2000);
  const nested = asObject(event.error);
  if (nested) {
    const message = stringValue(nested.message);
    if (message) return truncate(message, 2000);
    const name = stringValue(nested.type) || stringValue(nested.name);
    if (name) return truncate(name, 2000);
  }
  const serialized = stringValue(event.error);
  if (serialized) return truncate(serialized, 2000);
  return 'Unknown CLI error';
}

function textLines(
  raw: string,
  stream: LogStream,
  level: LogLevel,
): CliLogLine[] {
  return stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      stream,
      level,
      message: limit(redact(line)),
    }));
}

function limit(value: string): string {
  return value.slice(0, MAX_LINE_LENGTH);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Defense in depth: even if a CLI prints a credential, it must not be
 * persisted in the execution log or forwarded over the event stream.
 */
function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{10,}/gi, '$1***')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s"']{6,}/gi,
      '$1***',
    );
}
