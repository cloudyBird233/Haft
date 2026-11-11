import { Global, Module } from '@nestjs/common';
import { RepositoryValidationService } from './repository-validation.service';
import { RunnerGateway } from './runner.gateway';
import { RunnersController } from './runners.controller';
import { RunnerRegistryService } from './runner-registry.service';

@Global()
@Module({
  controllers: [RunnersController],
  providers: [RunnerRegistryService, RepositoryValidationService, RunnerGateway],
  exports: [RunnerRegistryService, RepositoryValidationService],
})
export class RunnersModule {}
