import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  cancelExecutionSchema,
  executionListQuerySchema,
  executionLogsQuerySchema,
  type CancelExecutionInput,
  type ExecutionListQuery,
  type ExecutionLogsQuery,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ExecutionsService } from './executions.service';

@ApiTags('executions')
@Controller('executions')
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Get()
  @ApiOperation({ summary: 'List executions by task, agent, or status' })
  list(
    @Query(new ZodValidationPipe(executionListQuerySchema)) query: ExecutionListQuery,
  ) {
    return this.executions.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single execution' })
  findOne(@Param('id') id: string) {
    return this.executions.findOne(id);
  }

  @Get(':id/logs')
  @ApiOperation({ summary: 'Read execution logs in sequence order' })
  logs(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(executionLogsQuerySchema)) query: ExecutionLogsQuery,
  ) {
    return this.executions.logs(id, query);
  }

  @Get(':id/diff')
  @ApiOperation({ summary: 'Read the stored unified Git diff for an execution' })
  diff(@Param('id') id: string) {
    return this.executions.diff(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a running execution' })
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelExecutionSchema)) body: CancelExecutionInput,
  ) {
    return this.executions.cancel(id, body);
  }
}
