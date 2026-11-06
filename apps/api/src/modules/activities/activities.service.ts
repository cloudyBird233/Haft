import { Injectable } from '@nestjs/common';
import type { ActivityDto, ActivityType, ListDto } from '@raft-lite/contracts';
import type { ActivityListQuery } from '@raft-lite/contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { activityRelations, toActivityDto } from '../../common/serializers';
import { EventsGateway } from '../events/events.gateway';

export interface RecordActivityInput {
  type: ActivityType;
  summary: string;
  taskId?: string | null;
  agentId?: string | null;
  executionId?: string | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
  ) {}

  async record(input: RecordActivityInput, workspaceId = 'ws_demo'): Promise<ActivityDto | null> {
    try {
      const activity = await this.prisma.activity.create({
        data: {
          workspaceId,
          type: input.type,
          summary: input.summary,
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
          executionId: input.executionId ?? null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
        include: activityRelations,
      });
      const dto = toActivityDto(activity);
      this.events.emitActivity(dto);
      return dto;
    } catch {
      // A history write must never roll back a completed business operation.
      return null;
    }
  }

  async list(query: ActivityListQuery): Promise<ListDto<ActivityDto>> {
    const where: Prisma.ActivityWhereInput = {};
    const [items, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        include: activityRelations,
        orderBy: { createdAt: 'desc' },
        skip: query.offset ?? 0,
        take: query.limit ?? 30,
      }),
      this.prisma.activity.count({ where }),
    ]);
    return { items: items.map(toActivityDto), total };
  }
}
