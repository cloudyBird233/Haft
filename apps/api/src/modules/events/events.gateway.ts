import { Logger } from '@nestjs/common';
import type {
  OnGatewayConnection,
  OnGatewayDisconnect} from '@nestjs/websockets';
import {
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { ActivityDto, AgentDto, ExecutionDto, ExecutionLogDto, TaskDto } from '@raft-lite/contracts';

export const SOCKET_EVENTS = {
  taskUpdated: 'task.updated',
  taskRemoved: 'task.removed',
  agentUpdated: 'agent.updated',
  agentRemoved: 'agent.removed',
  executionUpdated: 'execution.updated',
  executionLog: 'execution.log',
  activityCreated: 'activity.created',
} as const;

const allowedOrigins = (): string[] | true => {
  const origins = process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim());
  return origins && origins.length > 0 ? origins : true;
};

@WebSocketGateway({
  namespace: '/events',
  cors: { origin: allowedOrigins(), credentials: true },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  handleConnection(client: Socket): void {
    this.logger.log(`Socket connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Socket disconnected: ${client.id}`);
  }

  emitTaskUpdated(task: TaskDto): void {
    this.server?.emit(SOCKET_EVENTS.taskUpdated, task);
  }

  emitTaskRemoved(taskId: string): void {
    this.server?.emit(SOCKET_EVENTS.taskRemoved, { id: taskId });
  }

  emitAgentUpdated(agent: AgentDto): void {
    this.server?.emit(SOCKET_EVENTS.agentUpdated, agent);
  }

  emitAgentRemoved(agentId: string): void {
    this.server?.emit(SOCKET_EVENTS.agentRemoved, { id: agentId });
  }

  emitExecutionUpdated(execution: ExecutionDto): void {
    this.server?.emit(SOCKET_EVENTS.executionUpdated, execution);
  }

  emitExecutionLog(log: ExecutionLogDto): void {
    this.server?.emit(SOCKET_EVENTS.executionLog, log);
  }

  emitActivity(activity: ActivityDto): void {
    this.server?.emit(SOCKET_EVENTS.activityCreated, activity);
  }
}
