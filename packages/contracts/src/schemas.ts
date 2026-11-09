import { z } from 'zod';
import {
  AGENT_RUNTIMES,
  AGENT_STATUSES,
  EXECUTABLE_RUNTIMES,
  EXECUTION_STATUSES,
  LOG_LEVELS,
  PROJECT_BINDING_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './constants';
import { repositoryDefaultBranchSchema, repositoryPathSchema } from './runner-protocol';

const id = z.string().trim().min(1, 'ID is required').max(100);
const nonEmptyId = id;

export const agentRuntimeSchema = z.enum(AGENT_RUNTIMES);
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
export const projectBindingStatusSchema = z.enum(PROJECT_BINDING_STATUSES);
export const logLevelSchema = z.enum(LOG_LEVELS);
export const executableRuntimeSchema = z.enum(EXECUTABLE_RUNTIMES);

const name = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(60, 'Name must be at most 60 characters');
const role = z
  .string()
  .trim()
  .min(2, 'Role must be at least 2 characters')
  .max(80, 'Role must be at most 80 characters');
const description = z.string().trim().max(2000, 'Description is too long').optional().default('');
const taskTitle = z
  .string()
  .trim()
  .min(3, 'Title must be at least 3 characters')
  .max(140, 'Title must be at most 140 characters');

const projectName = z
  .string()
  .trim()
  .min(2, 'Project name must be at least 2 characters')
  .max(80, 'Project name must be at most 80 characters');

/**
 * Project keys are workspace-scoped human identifiers. They are normalised to
 * uppercase so `api` and `API` cannot create two projects that look identical.
 */
const projectKey = z
  .string()
  .trim()
  .min(2, 'Project key must be at least 2 characters')
  .max(12, 'Project key must be at most 12 characters')
  .transform((value) => value.toUpperCase())
  .refine(
    (value) => /^[A-Z][A-Z0-9_-]*$/.test(value),
    'Project key must start with a letter and contain only letters, digits, "_" or "-"',
  );

const projectColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a six-digit hex value such as #6b7280');

function isRepositoryUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol);
  } catch {
    // SCP-like SSH syntax (git@example.com:org/repo.git) is not a URL, but it
    // is an accepted repository address in every Git client.
    return /^git@[A-Za-z0-9._-]+:[^\s]+$/.test(value);
  }
}

const repositoryUrl = z
  .union([z.string().trim().max(2000, 'Repository URL is too long'), z.null()])
  .optional()
  .transform((value) => (value ? value : null))
  .refine(
    (value) => value === null || isRepositoryUrl(value),
    'Repository URL must be an http(s), ssh, git URL, or git@host:path address',
  );

export const createProjectSchema = z
  .object({
    key: projectKey,
    name: projectName,
    description: z.string().trim().max(2000, 'Description is too long').optional().default(''),
    color: projectColor.optional().default('#6b7280'),
    repoUrl: repositoryUrl,
    defaultBranch: repositoryDefaultBranchSchema.optional().default('main'),
  })
  .strict();

export const updateProjectSchema = z
  .object({
    name: projectName.optional(),
    description: z.string().trim().max(2000, 'Description is too long').optional(),
    color: projectColor.optional(),
    repoUrl: repositoryUrl.optional(),
    defaultBranch: repositoryDefaultBranchSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createProjectBindingSchema = z
  .object({
    computerId: nonEmptyId,
    path: repositoryPathSchema,
  })
  .strict();

/**
 * PATCH accepts no field except `path`. The controller inspects unknown keys
 * before applying this schema so immutable fields produce
 * `BINDING_FIELD_IMMUTABLE` instead of a generic validation error.
 */
export const updateProjectBindingSchema = z
  .object({
    path: repositoryPathSchema.optional(),
  })
  .passthrough();

export const createAgentSchema = z
  .object({
    name,
    role,
    description,
    runtime: agentRuntimeSchema.default('mock'),
    computerId: nonEmptyId.nullable().optional().default(null),
  })
  .strict();

export const updateAgentSchema = z
  .object({
    name: name.optional(),
    role: role.optional(),
    description: z.string().trim().max(2000, 'Description is too long').optional(),
    runtime: agentRuntimeSchema.optional(),
    computerId: nonEmptyId.nullable().optional(),
    status: agentStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createTaskSchema = z
  .object({
    title: taskTitle,
    description: z.string().trim().max(4000, 'Description is too long').optional().default(''),
    projectId: nonEmptyId,
    assigneeAgentId: nonEmptyId.nullable().optional().default(null),
    priority: taskPrioritySchema.default('medium'),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: taskTitle.optional(),
    description: z.string().trim().max(4000, 'Description is too long').optional(),
    projectId: nonEmptyId.optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const assignTaskSchema = z
  .object({
    agentId: nonEmptyId.nullable(),
  })
  .strict();

export const cancelTaskSchema = z
  .object({
    reason: z.string().trim().max(500, 'Reason is too long').optional(),
  })
  .strict()
  .optional();

export const agentListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: agentStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const taskListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  projectId: z.string().trim().optional(),
  assigneeAgentId: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const executionListQuerySchema = z.object({
  taskId: z.string().trim().optional(),
  agentId: z.string().trim().optional(),
  status: executionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const executionLogsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const activityListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const runnerRuntimeAvailabilityQuerySchema = z.object({
  computerId: z.string().trim().min(1).max(100).optional(),
  projectId: z.string().trim().min(1).max(100).optional(),
});

export const cancelExecutionSchema = z
  .object({
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .optional();

export const seedRequestSchema = z
  .object({
    preset: z.enum(['default', 'empty']).optional().default('default'),
  })
  .strict();

export const runtimeModeSchema = z
  .object({
    mode: z.enum(['auto', 'manual']),
  })
  .strict();

export const advanceExecutionSchema = z
  .object({
    steps: z.number().int().min(1).max(20).optional().default(1),
  })
  .strict();

export const finishExecutionSchema = z
  .object({
    outcome: z.enum(['success', 'failure']),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateProjectBindingInput = z.infer<typeof createProjectBindingSchema>;
export type UpdateProjectBindingInput = z.infer<typeof updateProjectBindingSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type AssignTaskInput = z.infer<typeof assignTaskSchema>;
export type CancelTaskInput = z.infer<typeof cancelTaskSchema>;
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
export type ExecutionListQuery = z.infer<typeof executionListQuerySchema>;
export type ExecutionLogsQuery = z.infer<typeof executionLogsQuerySchema>;
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
export type RunnerRuntimeAvailabilityQuery = z.infer<typeof runnerRuntimeAvailabilityQuerySchema>;
export type CancelExecutionInput = z.infer<typeof cancelExecutionSchema>;
export type SeedRequestInput = z.infer<typeof seedRequestSchema>;
export type RuntimeModeInput = z.infer<typeof runtimeModeSchema>;
export type AdvanceExecutionInput = z.infer<typeof advanceExecutionSchema>;
export type FinishExecutionInput = z.infer<typeof finishExecutionSchema>;
