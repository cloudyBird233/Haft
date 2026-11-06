import { z } from 'zod';
import {
  AGENT_RUNTIMES,
  AGENT_STATUSES,
  EXECUTABLE_RUNTIMES,
  EXECUTION_STATUSES,
  LOG_LEVELS,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './constants';

const id = z.string().trim().min(1, 'ID is required').max(100);
const nonEmptyId = id;

export const agentRuntimeSchema = z.enum(AGENT_RUNTIMES);
export const agentStatusSchema = z.enum(AGENT_STATUSES);
export const taskStatusSchema = z.enum(TASK_STATUSES);
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export const executionStatusSchema = z.enum(EXECUTION_STATUSES);
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
    description: z
      .string()
      .trim()
      .max(4000, 'Description is too long')
      .optional()
      .default(''),
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
export type CancelExecutionInput = z.infer<typeof cancelExecutionSchema>;
export type SeedRequestInput = z.infer<typeof seedRequestSchema>;
export type RuntimeModeInput = z.infer<typeof runtimeModeSchema>;
export type AdvanceExecutionInput = z.infer<typeof advanceExecutionSchema>;
export type FinishExecutionInput = z.infer<typeof finishExecutionSchema>;
