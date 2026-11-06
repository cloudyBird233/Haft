import type { PrismaClient } from '@prisma/client';
import { DEFAULT_PROJECT_ID, DEFAULT_WORKSPACE_ID } from '../constants';

const at = (iso: string) => new Date(iso);
const SEED = {
  workspace: at('2026-01-05T09:00:00.000Z'),
  agents: at('2026-01-06T10:00:00.000Z'),
  taskOne: at('2026-01-08T09:30:00.000Z'),
  taskTwo: at('2026-01-09T11:15:00.000Z'),
  taskThree: at('2026-01-10T08:45:00.000Z'),
  taskFour: at('2026-01-11T13:20:00.000Z'),
  execution: at('2026-01-12T14:00:00.000Z'),
  log: at('2026-01-12T14:00:03.000Z'),
  activity: at('2026-01-12T14:05:00.000Z'),
} as const;

export const SEED_IDS = {
  workspace: DEFAULT_WORKSPACE_ID,
  project: DEFAULT_PROJECT_ID,
  computer: 'computer_local',
  architect: 'agent_architect',
  developer: 'agent_developer',
  qa: 'agent_qa',
  taskDone: 'task_workspace_shell',
  taskReview: 'task_arch_review',
  taskTodo: 'task_log_viewer',
  taskClaimed: 'task_activity_contract',
  executionCompleted: 'execution_seed_completed',
} as const;

export async function clearAllData(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction([
    prisma.executionLog.deleteMany(),
    prisma.activity.deleteMany(),
    prisma.execution.deleteMany(),
    prisma.task.deleteMany(),
    prisma.agent.deleteMany(),
    prisma.project.deleteMany(),
    prisma.computer.deleteMany(),
    prisma.workspace.deleteMany(),
  ]);
}

/**
 * Deterministic seed used by local development, API tests and E2E tests.
 * All dates are fixed so screenshots and API assertions stay stable.
 */
export async function initializeDemoData(
  prisma: PrismaClient,
  preset: 'default' | 'empty' = 'default',
): Promise<void> {
  const workspace = await prisma.workspace.upsert({
    where: { id: SEED_IDS.workspace },
    update: { name: 'Raft Lite' },
    create: {
      id: SEED_IDS.workspace,
      name: 'Raft Lite',
      slug: 'raft-lite',
      createdAt: SEED.workspace,
      updatedAt: SEED.workspace,
    },
  });

  await prisma.computer.upsert({
    where: { id: SEED_IDS.computer },
    update: {},
    create: {
      id: SEED_IDS.computer,
      name: 'Local Workstation',
      hostname: 'localhost',
      status: 'online',
      lastSeenAt: SEED.workspace,
      createdAt: SEED.workspace,
    },
  });

  await prisma.project.upsert({
    where: { id: SEED_IDS.project },
    update: {},
    create: {
      id: SEED_IDS.project,
      workspaceId: workspace.id,
      key: 'RAFT',
      name: 'Raft Lite',
      description: 'Human-in-the-loop agent collaboration platform.',
      color: '#6f6a60',
      createdAt: SEED.workspace,
    },
  });

  const agents = [
    {
      id: SEED_IDS.architect,
      name: 'Architect',
      role: 'System Architect',
      description:
        'Owns system boundaries, translates product requirements into technical plans, and breaks work into executable tasks.',
      runtime: 'mock',
      status: 'idle',
      createdAt: SEED.agents,
      lastActiveAt: at('2026-01-11T12:00:00.000Z'),
    },
    {
      id: SEED_IDS.developer,
      name: 'Developer',
      role: 'Full-stack Engineer',
      description:
        'Implements product slices end to end, writes tests alongside code, and keeps the workspace build green.',
      runtime: 'mock',
      status: 'idle',
      createdAt: at('2026-01-06T10:05:00.000Z'),
      lastActiveAt: at('2026-01-12T14:02:00.000Z'),
    },
    {
      id: SEED_IDS.qa,
      name: 'QA Engineer',
      role: 'Quality Engineer',
      description:
        'Validates behavior across the API and UI, owns the regression suite, and turns failures into actionable reports.',
      runtime: 'mock',
      status: 'idle',
      createdAt: at('2026-01-06T10:10:00.000Z'),
      lastActiveAt: at('2026-01-10T09:00:00.000Z'),
    },
  ] as const;

  for (const agent of agents) {
    await prisma.agent.upsert({
      where: { id: agent.id },
      update: {},
      create: {
        ...agent,
        workspaceId: workspace.id,
        computerId: SEED_IDS.computer,
      },
    });
  }

  if (preset === 'empty') {
    return;
  }

  const tasks = [
    {
      id: SEED_IDS.taskDone,
      title: 'Scaffold the Raft Lite workspace shell',
      description:
        'Create the persistent shell, neutral visual system, responsive navigation, and stable test selectors for primary routes.',
      assigneeAgentId: SEED_IDS.developer,
      priority: 'high',
      status: 'done',
      createdAt: SEED.taskOne,
      updatedAt: SEED.execution,
    },
    {
      id: SEED_IDS.taskReview,
      title: 'Review runtime adapter boundaries',
      description:
        'Confirm the AgentRuntime interface isolates process execution from HTTP handling and document the path to Codex and OpenCode.',
      assigneeAgentId: SEED_IDS.architect,
      priority: 'high',
      status: 'in_review',
      createdAt: SEED.taskTwo,
      updatedAt: at('2026-01-11T16:30:00.000Z'),
    },
    {
      id: SEED_IDS.taskTodo,
      title: 'Add live execution log viewer',
      description:
        'Render streamed execution logs with accessible live-region semantics, auto-scroll, and a deterministic empty state.',
      assigneeAgentId: null,
      priority: 'medium',
      status: 'todo',
      createdAt: SEED.taskThree,
      updatedAt: SEED.taskThree,
    },
    {
      id: SEED_IDS.taskClaimed,
      title: 'Define activity event contract',
      description:
        'Document activity types, summary text, and correlation identifiers consumed by the dashboard timeline.',
      assigneeAgentId: SEED_IDS.qa,
      priority: 'low',
      status: 'claimed',
      createdAt: SEED.taskFour,
      updatedAt: SEED.taskFour,
    },
  ] as const;

  for (const task of tasks) {
    await prisma.task.upsert({
      where: { id: task.id },
      update: {},
      create: {
        ...task,
        workspaceId: workspace.id,
        projectId: SEED_IDS.project,
      },
    });
  }

  await prisma.execution.upsert({
    where: { id: SEED_IDS.executionCompleted },
    update: {},
    create: {
      id: SEED_IDS.executionCompleted,
      taskId: SEED_IDS.taskDone,
      agentId: SEED_IDS.developer,
      runtime: 'mock',
      status: 'completed',
      progress: 100,
      startedAt: SEED.execution,
      endedAt: at('2026-01-12T14:00:18.000Z'),
      createdAt: SEED.execution,
    },
  });

  const logs = [
    'Mock runtime attached; execution accepted.',
    'Loaded workspace shell and component conventions.',
    'Applied navigation and layout updates.',
    'Validated responsive shell at all acceptance viewports.',
    'Execution completed successfully.',
  ];

  for (const [index, message] of logs.entries()) {
    const seq = index + 1;
    await prisma.executionLog.upsert({
      where: { executionId_seq: { executionId: SEED_IDS.executionCompleted, seq } },
      update: {},
      create: {
        id: `log_seed_${seq}`,
        executionId: SEED_IDS.executionCompleted,
        seq,
        level: index === logs.length - 1 ? 'success' : 'info',
        message,
        timestamp: new Date(SEED.log.getTime() + index * 3000),
      },
    });
  }

  const activities = [
    {
      id: 'activity_seed_1',
      type: 'execution.completed',
      summary: 'Developer completed “Scaffold the Raft Lite workspace shell”',
      taskId: SEED_IDS.taskDone,
      agentId: SEED_IDS.developer,
      executionId: SEED_IDS.executionCompleted,
      createdAt: SEED.activity,
    },
    {
      id: 'activity_seed_2',
      type: 'task.assigned',
      summary: 'Architect was assigned “Review runtime adapter boundaries”',
      taskId: SEED_IDS.taskReview,
      agentId: SEED_IDS.architect,
      executionId: null,
      createdAt: at('2026-01-11T16:30:00.000Z'),
    },
    {
      id: 'activity_seed_3',
      type: 'task.created',
      summary: 'Created “Add live execution log viewer”',
      taskId: SEED_IDS.taskTodo,
      agentId: null,
      executionId: null,
      createdAt: SEED.taskThree,
    },
    {
      id: 'activity_seed_4',
      type: 'agent.created',
      summary: 'Added QA Engineer to the workspace',
      taskId: null,
      agentId: SEED_IDS.qa,
      executionId: null,
      createdAt: SEED.agents,
    },
  ] as const;

  for (const activity of activities) {
    await prisma.activity.upsert({
      where: { id: activity.id },
      update: {},
      create: {
        id: activity.id,
        workspaceId: workspace.id,
        type: activity.type,
        summary: activity.summary,
        taskId: activity.taskId,
        agentId: activity.agentId,
        executionId: activity.executionId,
        createdAt: activity.createdAt,
      },
    });
  }
}
