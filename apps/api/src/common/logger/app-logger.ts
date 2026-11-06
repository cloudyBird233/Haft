import { Global, Injectable, Module, Scope } from '@nestjs/common';

export interface StructuredLogEntry {
  eventType: string;
  message: string;
  status?: string | number;
  requestId?: string;
  taskId?: string;
  agentId?: string;
  executionId?: string;
  error?: string;
  [key: string]: unknown;
}

@Injectable({ scope: Scope.DEFAULT })
export class AppLogger {
  info(entry: StructuredLogEntry): void {
    this.write('info', entry);
  }

  warn(entry: StructuredLogEntry): void {
    this.write('warn', entry);
  }

  error(entry: StructuredLogEntry): void {
    this.write('error', entry);
  }

  private write(level: 'info' | 'warn' | 'error', entry: StructuredLogEntry): void {
    const record = {
      timestamp: new Date().toISOString(),
      level,
      ...entry,
    };
    const line = JSON.stringify(record);
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }
  }
}

@Global()
@Module({
  providers: [AppLogger],
  exports: [AppLogger],
})
export class AppLoggerModule {}
