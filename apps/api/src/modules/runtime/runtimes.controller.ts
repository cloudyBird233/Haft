import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  runnerRuntimeAvailabilityQuerySchema,
  type RuntimeAvailabilityDto,
  type RunnerRuntimeAvailabilityQuery,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { RuntimeRegistryService } from './runtime-registry.service';

@ApiTags('runtimes')
@Controller('runtimes')
export class RuntimesController {
  constructor(private readonly registry: RuntimeRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'Runtime availability for a computer and project' })
  async list(
    @Query(new ZodValidationPipe(runnerRuntimeAvailabilityQuerySchema))
    query: RunnerRuntimeAvailabilityQuery,
  ): Promise<{ items: RuntimeAvailabilityDto[] }> {
    const items = await this.registry.availability(query.computerId ?? null, query.projectId ?? null);
    return { items };
  }
}
