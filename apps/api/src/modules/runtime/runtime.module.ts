import { Global, Module } from '@nestjs/common';
import { RunnersModule } from '../runners/runners.module';
import { AGENT_RUNTIME } from './agent-runtime.interface';
import { MockRuntimeService } from './mock-runtime.service';
import { RuntimeRegistryService } from './runtime-registry.service';
import { RuntimesController } from './runtimes.controller';

@Global()
@Module({
  imports: [RunnersModule],
  controllers: [RuntimesController],
  providers: [
    MockRuntimeService,
    RuntimeRegistryService,
    {
      provide: AGENT_RUNTIME,
      useExisting: MockRuntimeService,
    },
  ],
  exports: [MockRuntimeService, RuntimeRegistryService, AGENT_RUNTIME],
})
export class RuntimeModule {}
