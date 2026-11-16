import { Global, Module } from '@nestjs/common';
import { HandshakeMessageService } from './handshake-message.service';
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
    HandshakeMessageService,
    RunnerGateway,
  ],
  exports: [
    RunnerRegistryService,
    RepositoryValidationService,
    RepositoryHandshakeService,
    HandshakeMessageService,
  ],
})
export class RunnersModule {}
