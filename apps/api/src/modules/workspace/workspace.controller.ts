import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';

@ApiTags('workspace')
@Controller()
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get('workspace')
  @ApiOperation({ summary: 'Get the active workspace and its projects' })
  getWorkspace() {
    return this.workspace.getWorkspace();
  }

  @Get('dashboard')
  @ApiOperation({ summary: 'Aggregated dashboard metrics and recent activity' })
  getDashboard() {
    return this.workspace.getDashboard();
  }
}
