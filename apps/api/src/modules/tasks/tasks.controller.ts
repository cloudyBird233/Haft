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
  assignTaskSchema,
  cancelTaskSchema,
  createTaskSchema,
  taskListQuerySchema,
  updateTaskSchema,
  type AssignTaskInput,
  type CancelExecutionInput,
  type CreateTaskInput,
  type TaskListQuery,
  type UpdateTaskInput,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ExecutionsService } from '../executions/executions.service';
import { TasksService } from './tasks.service';

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly executions: ExecutionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List and filter tasks' })
  list(@Query(new ZodValidationPipe(taskListQuerySchema)) query: TaskListQuery) {
    return this.tasks.list(query);
  }

  @Post()
  @ApiOperation({ summary: 'Create a task' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['title', 'projectId'],
      properties: {
        title: { type: 'string', example: 'Implement audit trail' },
        description: { type: 'string' },
        projectId: { type: 'string' },
        assigneeAgentId: { type: 'string', nullable: true },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      },
    },
  })
  create(@Body(new ZodValidationPipe(createTaskSchema)) body: CreateTaskInput) {
    return this.tasks.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get task detail with execution history' })
  findOne(@Param('id') id: string) {
    return this.tasks.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update task fields or transition status' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) body: UpdateTaskInput,
  ) {
    return this.tasks.update(id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a task with no active execution' })
  remove(@Param('id') id: string) {
    return this.tasks.remove(id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Assign or unassign an agent' })
  assign(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(assignTaskSchema)) body: AssignTaskInput,
  ) {
    return this.tasks.assign(id, body);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Start a mock execution for this task' })
  start(@Param('id') id: string) {
    return this.executions.startForTask(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a task and any active execution' })
  cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelTaskSchema)) body: CancelExecutionInput,
  ) {
    return this.executions.cancelTask(id, body);
  }
}
