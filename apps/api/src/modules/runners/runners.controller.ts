import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ListDto, RunnerDto } from '@raft-lite/contracts';
import type { Request } from 'express';
import { RunnerRegistryService } from './runner-registry.service';
import { assertRunnerAdminAccess } from './runner-access';

@ApiTags('runners')
@Controller('runners')
export class RunnersController {
  constructor(private readonly runners: RunnerRegistryService) {}

  @Get()
  @ApiOperation({ summary: 'List registered runners' })
  async list(@Req() request: Request): Promise<ListDto<RunnerDto>> {
    assertRunnerAdminAccess(request);
    const items = await this.runners.list();
    return { items, total: items.length };
  }
}
