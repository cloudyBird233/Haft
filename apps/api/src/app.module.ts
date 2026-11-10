import { Module } from '@nestjs/common';
import { ActivitiesModule } from './modules/activities/activities.module';
import { AgentsModule } from './modules/agents/agents.module';
import { ComputersModule } from './modules/computers/computers.module';
import { EventsModule } from './modules/events/events.module';
import { ExecutionsModule } from './modules/executions/executions.module';
import { HealthModule } from './modules/health/health.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RuntimeModule } from './modules/runtime/runtime.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { TestModule } from './modules/test/test.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { AppLoggerModule } from './common/logger/app-logger';
import { PrismaModule } from './common/prisma/prisma.module';
import { SeedModule } from './common/seed/seed.module';

const testModeEnabled =
  process.env.E2E_TEST_MODE === 'true' && process.env.NODE_ENV !== 'production';

@Module({
  imports: [
    PrismaModule,
    AppLoggerModule,
    SeedModule,
    EventsModule,
    ActivitiesModule,
    RuntimeModule,
    AgentsModule,
    ProjectsModule,
    TasksModule,
    ExecutionsModule,
    ComputersModule,
    WorkspaceModule,
    HealthModule,
    ...(testModeEnabled ? [TestModule] : []),
  ],
})
export class AppModule {}
