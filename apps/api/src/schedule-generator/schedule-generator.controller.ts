import {
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Param,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ScheduleGeneratorService } from './schedule-generator.service';
import { GenerateDto, GenerateMode, UpdateAutomationDto } from './dto/generate.dto';

interface AuthRequest {
  user?: { id?: string };
}

@Controller('studios/:studioId/schedule-generator')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ScheduleGeneratorController {
  constructor(private readonly service: ScheduleGeneratorService) {}

  /** Calendar coverage summary. */
  @Get('status')
  getStatus(@Param('studioId') studioId: string) {
    return this.service.getStatus(studioId);
  }

  /** Dry-run preview — no DB writes. Owner/Admin only. */
  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  preview(@Param('studioId') studioId: string, @Body() dto: GenerateDto) {
    const { from, to } = this.resolveDateRange(dto);
    return this.service.preview(studioId, from, to);
  }

  /** Actual generation run. Owner/Admin only. */
  @Post('generate')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  generate(
    @Param('studioId') studioId: string,
    @Body() dto: GenerateDto,
    @Request() req: AuthRequest,
  ) {
    const { from, to } = this.resolveDateRange(dto);
    return this.service.generateRange(studioId, from, to, {
      isDryRun: false,
      triggeredBy: 'MANUAL',
      userId: req.user?.id,
    });
  }

  /** History of past runs. */
  @Get('runs')
  listRuns(@Param('studioId') studioId: string) {
    return this.service.listRuns(studioId);
  }

  /** Current automation settings. */
  @Get('automation')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  getAutomation(@Param('studioId') studioId: string) {
    return this.service.getAutomation(studioId);
  }

  /** Update automation settings. */
  @Patch('automation')
  @UseGuards(RolesGuard)
  @Roles('OWNER', 'ADMIN')
  updateAutomation(
    @Param('studioId') studioId: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.service.updateAutomation(studioId, dto.enabled, dto.minFutureDays);
  }

  private resolveDateRange(dto: GenerateDto): { from: Date; to: Date } {
    const from = new Date();
    let to: Date;

    switch (dto.mode) {
      case GenerateMode.NEXT_30:
        to = new Date(from.getTime() + 30 * 86_400_000);
        break;
      case GenerateMode.NEXT_90:
        to = new Date(from.getTime() + 90 * 86_400_000);
        break;
      case GenerateMode.END_OF_YEAR:
        to = new Date(Date.UTC(from.getUTCFullYear(), 11, 31, 23, 59, 59));
        break;
      case GenerateMode.CUSTOM:
        to = new Date(dto.toDate!);
        break;
    }

    return { from, to };
  }
}
