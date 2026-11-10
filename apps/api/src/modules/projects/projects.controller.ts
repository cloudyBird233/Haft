import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createProjectBindingSchema,
  createProjectSchema,
  updateProjectSchema,
  type CreateProjectBindingInput,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'List projects with task and execution counts' })
  list() {
    return this.projects.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a project' })
  create(@Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput) {
    return this.projects.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a project, its counts, and repository bindings' })
  findOne(@Param('id') id: string) {
    return this.projects.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a project or archive/unarchive it' })
  update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
  ) {
    return this.projects.update(id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a project that has no tasks' })
  remove(@Param('id') id: string) {
    return this.projects.remove(id);
  }

  @Get(':id/bindings')
  @ApiOperation({ summary: 'List repository bindings for a project' })
  listBindings(@Param('id') id: string) {
    return this.projects.listBindings(id);
  }

  @Post(':id/bindings')
  @ApiOperation({ summary: 'Create an unverified repository binding' })
  createBinding(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(createProjectBindingSchema))
    body: CreateProjectBindingInput,
  ) {
    return this.projects.createBinding(id, body);
  }

  @Patch(':id/bindings/:bindingId')
  @ApiOperation({ summary: 'Change a binding path; validation fields are immutable' })
  updateBinding(
    @Param('id') id: string,
    @Param('bindingId') bindingId: string,
    @Body() body: unknown,
  ) {
    return this.projects.updateBinding(id, bindingId, body);
  }

  @Delete(':id/bindings/:bindingId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a repository binding' })
  removeBinding(@Param('id') id: string, @Param('bindingId') bindingId: string) {
    return this.projects.removeBinding(id, bindingId);
  }
}
