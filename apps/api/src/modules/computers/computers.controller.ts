import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ComputerDto, ListDto } from '@raft-lite/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toComputerDto } from '../../common/serializers';

@ApiTags('computers')
@Controller('computers')
export class ComputersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List registered computers' })
  async list(): Promise<ListDto<ComputerDto>> {
    const records = await this.prisma.computer.findMany({ orderBy: { createdAt: 'asc' } });
    return { items: records.map(toComputerDto), total: records.length };
  }
}
