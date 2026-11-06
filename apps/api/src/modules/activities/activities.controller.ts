import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { activityListQuerySchema, type ActivityListQuery } from '@raft-lite/contracts';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ActivitiesService } from './activities.service';

@ApiTags('activities')
@Controller('activities')
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Get()
  @ApiOperation({ summary: 'List recent workspace activities' })
  list(
    @Query(new ZodValidationPipe(activityListQuerySchema)) query: ActivityListQuery,
  ) {
    return this.activities.list(query);
  }
}
