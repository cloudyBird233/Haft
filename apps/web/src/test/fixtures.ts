import type { AgentDto, ComputerDto, ProjectDto, TaskDto } from '@raft-lite/contracts';

const timestamp = '2026-01-12T14:00:00.000Z';

export const testComputer: ComputerDto = {
  id: 'computer_local',
  name: 'Local Workstation',
  hostname: 'localhost',
  status: 'online',
  lastSeenAt: timestamp,
  createdAt: timestamp,
};

export const testProject: ProjectDto = {
  id: 'project_demo',
  name: 'Raft Lite',
  key: 'RAFT',
  description: 'Demo project',
  color: '#6f6a60',
  createdAt: timestamp,
};

export const testAgents: AgentDto[] = [
  {
    id: 'agent_developer',
    workspaceId: 'ws_demo',
    name: 'Developer',
    role: 'Full-stack Engineer',
    description: 'Builds the product.',
    runtime: 'mock',
    status: 'idle',
    computerId: 'computer_local',
    computer: testComputer,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActiveAt: timestamp,
  },
  {
    id: 'agent_qa',
    workspaceId: 'ws_demo',
    name: 'QA Engineer',
    role: 'Quality Engineer',
    description: 'Tests the product.',
    runtime: 'mock',
    status: 'offline',
    computerId: 'computer_local',
    computer: testComputer,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastActiveAt: timestamp,
  },
];

export const testTasks: TaskDto[] = [
  {
    id: 'task_audit',
    workspaceId: 'ws_demo',
    title: 'Audit log viewer',
    description: 'Render the execution log stream.',
    projectId: 'project_demo',
    project: testProject,
    assignee: testAgents[0] ?? null,
    priority: 'high',
    status: 'in_progress',
    createdAt: timestamp,
    updatedAt: timestamp,
    latestExecution: null,
  },
  {
    id: 'task_settings',
    workspaceId: 'ws_demo',
    title: 'Ship settings panel',
    description: 'Add workspace settings.',
    projectId: 'project_demo',
    project: testProject,
    assignee: null,
    priority: 'medium',
    status: 'todo',
    createdAt: timestamp,
    updatedAt: timestamp,
    latestExecution: null,
  },
];
