import { Global, Module } from '@nestjs/common';
import { RunnerGateway } from './runner.gateway';
import { RunnersController } from './runners.controller';
import { RunnerRegistryService } from './runner-registry.service';

@Global()
@Module({
  controllers: [RunnersController],
  providers: [RunnerRegistryService, RunnerGateway],
  exports: [RunnerRegistryService],
})
export class RunnersModule {}
