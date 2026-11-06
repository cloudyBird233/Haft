import { PrismaClient } from '@prisma/client';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
    // SQLite on Windows defaults to a rollback journal + FULL synchronous mode,
    // which makes every write wait for a disk flush (hundreds of milliseconds).
    // WAL + NORMAL keeps writes durable across process crashes while making the
    // test suite and local development responsive.
    await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await this.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
    await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
