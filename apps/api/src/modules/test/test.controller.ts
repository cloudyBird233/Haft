import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  advanceExecutionSchema,
  finishExecutionSchema,
  runtimeModeSchema,
  seedRequestSchema,
  type AdvanceExecutionInput,
  type FinishExecutionInput,
  type RuntimeModeInput,
  type SeedRequestInput,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { TestService } from './test.service';

@ApiExcludeController()
@Controller('__test__')
export class TestController {
  constructor(private readonly testService: TestService) {}

  @Post('reset')
  @HttpCode(200)
  reset(
    @Body(new ZodValidationPipe(seedRequestSchema.optional()))
    body: SeedRequestInput | undefined,
  ) {
    return this.testService.reset(body?.preset ?? 'default');
  }

  @Post('seed')
  @HttpCode(200)
  seed(
    @Body(new ZodValidationPipe(seedRequestSchema.optional()))
    body: SeedRequestInput | undefined,
  ) {
    return this.testService.reset(body?.preset ?? 'default');
  }

  @Post('runtime/mode')
  @HttpCode(200)
  setRuntimeMode(
    @Body(new ZodValidationPipe(runtimeModeSchema)) body: RuntimeModeInput,
  ) {
    return this.testService.setMode(body);
  }

  @Post('executions/:id/advance')
  @HttpCode(200)
  advance(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(advanceExecutionSchema)) body: AdvanceExecutionInput,
  ) {
    return this.testService.advance(id, body.steps);
  }

  @Post('executions/:id/finish')
  @HttpCode(200)
  finish(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(finishExecutionSchema)) body: FinishExecutionInput,
  ) {
    return this.testService.finish(id, body);
  }
}
