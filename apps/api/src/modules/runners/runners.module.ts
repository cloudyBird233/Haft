import { Global, Module } from '@nestjs/common';
import { RepositoryHandshakeService } from './repository-handshake.service';
import { RepositoryValidationService } from './repository-validation.service';
import { RunnerGateway } from './runner.gateway';
import { RunnersController } from './runners.controller';
import { RunnerRegistryService } from './runner-registry.service';

@Global()
@Module({
  controllers: [RunnersController],
  providers: [
    RunnerRegistryService,
    RepositoryValidationService,
    RepositoryHandshakeService,
    RunnerGateway,
  ],
  exports: [RunnerRegistryService, RepositoryValidationService, RepositoryHandshakeService],
})
export class RunnersModule {}
