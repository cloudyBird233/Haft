import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EventsGateway } from '../src/modules/events/events.gateway';

export interface ApiSuccessBody<T> {
  data: T;
  requestId: string;
}

export async function createTestApp(): Promise<INestApplication> {
  const eventsStub = {
    emitTaskUpdated: vi.fn(),
    emitTaskRemoved: vi.fn(),
    emitAgentUpdated: vi.fn(),
    emitAgentRemoved: vi.fn(),
    emitExecutionUpdated: vi.fn(),
    emitExecutionLog: vi.fn(),
    emitActivity: vi.fn(),
  };

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EventsGateway)
    .useValue(eventsStub)
    .compile();

  const app = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 4000,
  intervalMs = 25,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await probe();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
