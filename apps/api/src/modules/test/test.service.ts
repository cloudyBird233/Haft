import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AdvanceExecutionResult,
  FinishExecutionInput,
  FinishExecutionResult,
  RuntimeModeInput,
  RuntimeModeResult,
  SeedRequestInput,
  TestResetResult,
} from '@raft-lite/contracts';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { clearAllData, initializeDemoData } from '../../common/seed/demo-data';
import { MockRuntimeService } from '../runtime/mock-runtime.service';

@Injectable()
export class TestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: MockRuntimeService,
  ) {}

  async reset(preset: SeedRequestInput['preset']): Promise<TestResetResult> {
    this.runtime.reset();
    await clearAllData(this.prisma);
    await initializeDemoData(this.prisma, preset);
    return { preset, seededAt: new Date().toISOString() };
  }

  setMode(input: RuntimeModeInput): RuntimeModeResult {
    this.runtime.setMode(input.mode);
    return { mode: input.mode };
  }

  async advance(executionId: string, steps: number): Promise<AdvanceExecutionResult> {
    const session = await this.runtime.getStatus(executionId);
    if (!session) {
      throw new AppException(
        'RUNTIME_SESSION_NOT_FOUND',
        'No mock runtime session exists for this execution',
        HttpStatus.NOT_FOUND,
      );
    }
    const result = this.runtime.advance(executionId, steps);
    if (!result) {
      throw new AppException(
        'RUNTIME_NOT_RUNNING',
        'The mock runtime session is no longer running',
        HttpStatus.CONFLICT,
      );
    }
    return {
      executionId,
      step: result.step,
      progress: result.progress,
      completed: result.completed,
    };
  }

  async finish(executionId: string, input: FinishExecutionInput): Promise<FinishExecutionResult> {
    const session = await this.runtime.getStatus(executionId);
    if (!session) {
      throw new AppException(
        'RUNTIME_SESSION_NOT_FOUND',
        'No mock runtime session exists for this execution',
        HttpStatus.NOT_FOUND,
      );
    }
    const emitted = this.runtime.finish(executionId, input.outcome, input.reason);
    if (!emitted) {
      throw new AppException(
        'RUNTIME_NOT_RUNNING',
        'The mock runtime session is no longer running',
        HttpStatus.CONFLICT,
      );
    }
    return { executionId, outcome: input.outcome, emitted };
  }
}
