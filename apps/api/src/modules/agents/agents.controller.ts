import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  agentListQuerySchema,
  createAgentSchema,
  updateAgentSchema,
  type AgentListQuery,
  type CreateAgentInput,
  type UpdateAgentInput,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AgentsService } from './agents.service';

@ApiTags('agents')
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'List and filter agents' })
  list(@Query(new ZodValidationPipe(agentListQuerySchema)) query: AgentListQuery) {
    return this.agents.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create an agent' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'role'],
      properties: {
        name: { type: 'string', example: 'Planner' },
        role: { type: 'string', example: 'Delivery Planner' },
        description: { type: 'string' },
        runtime: { type: 'string', enum: ['mock', 'codex', 'opencode'] },
        computerId: { type: 'string', nullable: true },
      },
    },
  })
  create(@Body(new ZodValidationPipe(createAgentSchema)) body: CreateAgentInput) {
    return this.agents.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an agent with current task and recent executions' })
  findOne(@Param('id') id: string) {
    return this.agents.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an agent' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAgentSchema)) body: UpdateAgentInput,
  ) {
    return this.agents.update(id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an idle agent' })
  remove(@Param('id') id: string) {
    return this.agents.remove(id);
  }
}
