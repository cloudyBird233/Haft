import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { initializeDemoData } from './demo-data';

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const workspaceCount = await this.prisma.workspace.count();
    if (workspaceCount === 0) {
      await initializeDemoData(this.prisma, 'default');
    }
  }
}
