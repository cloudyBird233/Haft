import { Global, Module } from '@nestjs/common';
import { AGENT_RUNTIME } from './agent-runtime.interface';
import { MockRuntimeService } from './mock-runtime.service';

@Global()
@Module({
  providers: [
    MockRuntimeService,
    {
      provide: AGENT_RUNTIME,
      useExisting: MockRuntimeService,
    },
  ],
  exports: [MockRuntimeService, AGENT_RUNTIME],
})
export class RuntimeModule {}
