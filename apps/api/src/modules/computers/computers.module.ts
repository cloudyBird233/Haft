import { Module } from '@nestjs/common';
import { ComputersController } from './computers.controller';

@Module({ controllers: [ComputersController] })
export class ComputersModule {}
