import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  repositoryPathSchema,
  type CreateProjectBindingInput,
  type CreateProjectInput,
  type ListDto,
  type ProjectBindingDto,
  type ProjectDetailDto,
  type ProjectDto,
  type RepositoryValidationResultDto,
  type UpdateProjectInput,
} from '@raft-lite/contracts';
import type { Prisma } from '@prisma/client';
import { DEFAULT_WORKSPACE_ID } from '../../common/constants';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  projectBindingRelations,
  toProjectBindingDto,
  toProjectDetailDto,
  toProjectDto,
} from '../../common/serializers';
import { RepositoryValidationService } from '../runners/repository-validation.service';

const IMMUTABLE_BINDING_FIELDS = new Set([
  'id',
  'projectId',
  'computerId',
  'pathHash',
  'bindingVersion',
  'platform',
  'status',
  'validationRequestId',
  'canonicalPath',
  'validationErrorCode',
  'validationError',
  'lastValidatedAt',
  'validatedByRunnerId',
  'validatedBindingVersion',
  'policyVersion',
  'defaultBranch',
  'archived',
  'archivedAt',
  'createdAt',
  'updatedAt',
]);

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repositoryValidation: RepositoryValidationService,
  ) {}

  async list(): Promise<ListDto<ProjectDto>> {
    const projects = await this.prisma.project.findMany({
      where: { workspaceId: DEFAULT_WORKSPACE_ID },
      include: {
        _count: { select: { tasks: true, repositoryBindings: true } },
      },
      orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
    });
    const executionCounts = await this.executionCountsByProject(
      projects.map((project) => project.id),
    );
    const items = projects.map((project) =>
      toProjectDto(project, {
        taskCount: project._count.tasks,
        executionCount: executionCounts.get(project.id) ?? 0,
        bindingCount: project._count.repositoryBindings,
      }),
    );
    return { items, total: items.length };
  }

  async findOne(id: string): Promise<ProjectDetailDto> {
    const project = await this.findProjectRecord(id);
    const bindings = await this.prisma.projectRepositoryBinding.findMany({
      where: { projectId: id },
      include: projectBindingRelations,
      orderBy: { createdAt: 'asc' },
    });
    const executionCounts = await this.executionCountsByProject([id]);
    return toProjectDetailDto(
      project,
      {
        taskCount: project._count.tasks,
        executionCount: executionCounts.get(id) ?? 0,
        bindingCount: bindings.length,
      },
      bindings,
    );
  }

  async create(input: CreateProjectInput): Promise<ProjectDto> {
    const existing = await this.prisma.project.findUnique({
      where: {
        workspaceId_key: {
          workspaceId: DEFAULT_WORKSPACE_ID,
          key: input.key,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw this.keyConflict(input.key);
    }
    try {
      const project = await this.prisma.project.create({
        data: {
          workspaceId: DEFAULT_WORKSPACE_ID,
          key: input.key,
          name: input.name,
          description: input.description,
          color: input.color,
          defaultBranch: input.defaultBranch,
        },
      });
      return toProjectDto(project, { taskCount: 0, executionCount: 0, bindingCount: 0 });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw this.keyConflict(input.key);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateProjectInput): Promise<ProjectDetailDto> {
    await this.findProjectRecord(id);
    const data: Prisma.ProjectUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.color !== undefined) data.color = input.color;
    if (input.defaultBranch !== undefined) data.defaultBranch = input.defaultBranch;
    if (input.archived !== undefined) {
      data.archivedAt = input.archived ? new Date() : null;
    }
    await this.prisma.project.update({ where: { id }, data });
    return this.findOne(id);
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.findProjectRecord(id);
    const taskCount = await this.prisma.task.count({ where: { projectId: id } });
    if (taskCount > 0) {
      throw new AppException(
        ERROR_CODES.PROJECT_HAS_TASKS,
        'Archive the project instead of deleting it while tasks reference it',
        HttpStatus.CONFLICT,
        { taskCount },
      );
    }
    await this.prisma.project.delete({ where: { id } });
    return { id };
  }

  async listBindings(projectId: string): Promise<ListDto<ProjectBindingDto>> {
    await this.findProjectRecord(projectId);
    const bindings = await this.prisma.projectRepositoryBinding.findMany({
      where: { projectId },
      include: projectBindingRelations,
      orderBy: { createdAt: 'asc' },
    });
    return { items: bindings.map(toProjectBindingDto), total: bindings.length };
  }

  async createBinding(
    projectId: string,
    input: CreateProjectBindingInput,
  ): Promise<ProjectBindingDto> {
    await this.findProjectRecord(projectId);
    const computer = await this.prisma.computer.findUnique({
      where: { id: input.computerId },
      select: { id: true },
    });
    if (!computer) {
      throw new AppException(
        'COMPUTER_NOT_FOUND',
        'The selected computer does not exist',
        HttpStatus.NOT_FOUND,
      );
    }
    const path = this.parseBindingPath(input.path);
    const existing = await this.prisma.projectRepositoryBinding.findUnique({
      where: {
        projectId_computerId: { projectId, computerId: input.computerId },
      },
      select: { id: true },
    });
    if (existing) {
      throw this.duplicateBinding(projectId, input.computerId);
    }
    try {
      const binding = await this.prisma.projectRepositoryBinding.create({
        data: {
          projectId,
          computerId: input.computerId,
          path,
          pathHash: hashPath(path),
          bindingVersion: 1,
          status: 'unverified',
        },
        include: projectBindingRelations,
      });
      return toProjectBindingDto(binding);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw this.duplicateBinding(projectId, input.computerId);
      }
      throw error;
    }
  }

  async updateBinding(
    projectId: string,
    bindingId: string,
    body: unknown,
  ): Promise<ProjectBindingDto> {
    await this.findProjectRecord(projectId);
    const binding = await this.findBindingRecord(projectId, bindingId);
    const path = this.parseBindingPatch(body);

    if (path === binding.path) {
      return toProjectBindingDto(
        await this.prisma.projectRepositoryBinding.findUniqueOrThrow({
          where: { id: binding.id },
          include: projectBindingRelations,
        }),
      );
    }

    const updated = await this.prisma.projectRepositoryBinding.update({
      where: { id: binding.id },
      data: {
        path,
        pathHash: hashPath(path),
        bindingVersion: { increment: 1 },
        status: 'unverified',
        validationRequestId: null,
        canonicalPath: null,
        validationErrorCode: null,
        validationError: null,
        lastValidatedAt: null,
        validatedByRunnerId: null,
        validatedBindingVersion: null,
        policyVersion: null,
        platform: null,
      },
      include: projectBindingRelations,
    });
    return toProjectBindingDto(updated);
  }

  async removeBinding(projectId: string, bindingId: string): Promise<{ id: string }> {
    await this.findProjectRecord(projectId);
    const binding = await this.findBindingRecord(projectId, bindingId);
    await this.prisma.projectRepositoryBinding.delete({ where: { id: binding.id } });
    return { id: binding.id };
  }

  /**
   * Explicit user action. Binding create/update/delete never call this method
   * and never emit a runner message.
   */
  validateBinding(projectId: string, bindingId: string): Promise<RepositoryValidationResultDto> {
    return this.repositoryValidation.validateBinding(projectId, bindingId);
  }

  private async findProjectRecord(id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, workspaceId: DEFAULT_WORKSPACE_ID },
      include: { _count: { select: { tasks: true } } },
    });
    if (!project) {
      throw new AppException(
        ERROR_CODES.PROJECT_NOT_FOUND,
        'Project not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return project;
  }

  private async findBindingRecord(projectId: string, bindingId: string) {
    const binding = await this.prisma.projectRepositoryBinding.findFirst({
      where: { id: bindingId, projectId },
    });
    if (!binding) {
      throw new AppException(
        ERROR_CODES.BINDING_NOT_FOUND,
        'Repository binding not found',
        HttpStatus.NOT_FOUND,
        { projectId, bindingId },
      );
    }
    return binding;
  }

  private parseBindingPath(value: string): string {
    const parsed = repositoryPathSchema.safeParse(value);
    if (!parsed.success) {
      throw new AppException(
        ERROR_CODES.BINDING_PATH_INVALID,
        'Repository path is invalid',
        HttpStatus.BAD_REQUEST,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || 'path',
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }

  private parseBindingPatch(body: unknown): string {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ path: 'root', message: 'Expected a JSON object' }],
      );
    }
    const record = body as Record<string, unknown>;
    const immutableFields = Object.keys(record).filter(
      (key) => key !== 'path' && IMMUTABLE_BINDING_FIELDS.has(key),
    );
    if (immutableFields.length > 0) {
      throw new AppException(
        ERROR_CODES.BINDING_FIELD_IMMUTABLE,
        'Only the repository path can be updated on a binding',
        HttpStatus.BAD_REQUEST,
        { fields: immutableFields },
      );
    }
    const unknownFields = Object.keys(record).filter((key) => key !== 'path');
    if (unknownFields.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        unknownFields.map((field) => ({
          path: field,
          message: 'Unknown field',
        })),
      );
    }
    if (typeof record.path !== 'string') {
      throw new AppException(
        ERROR_CODES.BINDING_PATH_INVALID,
        'Repository path is required',
        HttpStatus.BAD_REQUEST,
        [{ path: 'path', message: 'Repository path is required' }],
      );
    }
    return this.parseBindingPath(record.path);
  }

  private async executionCountsByProject(projectIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (projectIds.length === 0) return counts;
    const tasks = await this.prisma.task.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true },
    });
    if (tasks.length === 0) return counts;
    const groups = await this.prisma.execution.groupBy({
      by: ['taskId'],
      where: { taskId: { in: tasks.map((task) => task.id) } },
      _count: { _all: true },
    });
    const projectByTask = new Map(tasks.map((task) => [task.id, task.projectId]));
    for (const group of groups) {
      const projectId = projectByTask.get(group.taskId);
      if (!projectId) continue;
      counts.set(projectId, (counts.get(projectId) ?? 0) + group._count._all);
    }
    return counts;
  }

  private keyConflict(key: string): AppException {
    return new AppException(
      ERROR_CODES.PROJECT_KEY_CONFLICT,
      `Project key ${key} is already used in this workspace`,
      HttpStatus.CONFLICT,
      { key },
    );
  }

  private duplicateBinding(projectId: string, computerId: string): AppException {
    return new AppException(
      ERROR_CODES.BINDING_DUPLICATE_COMPUTER,
      'This computer already has a repository binding for the project',
      HttpStatus.CONFLICT,
      { projectId, computerId },
    );
  }
}

function hashPath(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002',
  );
}
