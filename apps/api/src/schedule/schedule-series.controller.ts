import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { ScheduleSeriesService } from './schedule-series.service';
import {
  CancelSeriesOccurrenceDto,
  CreateRecurringSeriesDto,
  EditSeriesOccurrenceDto,
} from './dto/schedule-series.dto';

interface AuthRequest {
  user?: { id?: string };
}

@Controller('studios/:studioId/schedule-series')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ScheduleSeriesController {
  constructor(private readonly seriesService: ScheduleSeriesService) {}

  @Post('preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  preview(
    @Param('studioId') studioId: string,
    @Body() dto: CreateRecurringSeriesDto,
  ) {
    return this.seriesService.previewCreate(studioId, dto);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateRecurringSeriesDto,
    @Request() req: AuthRequest,
  ) {
    return this.seriesService.createRecurringSeries(
      studioId,
      dto,
      req.user?.id ?? 'unknown',
    );
  }

  @Get('occurrences/:scheduledClassId/context')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getContext(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
  ) {
    return this.seriesService.getOccurrenceSeriesContext(studioId, scheduledClassId);
  }

  @Post('occurrences/:scheduledClassId/edit-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  editPreview(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: EditSeriesOccurrenceDto,
  ) {
    return this.seriesService.previewEditOccurrence(studioId, scheduledClassId, dto);
  }

  @Patch('occurrences/:scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  edit(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: EditSeriesOccurrenceDto,
    @Request() req: AuthRequest,
  ) {
    return this.seriesService.editOccurrence(
      studioId,
      scheduledClassId,
      dto,
      req.user?.id ?? 'unknown',
    );
  }

  @Post('occurrences/:scheduledClassId/cancel-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  cancelPreview(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: CancelSeriesOccurrenceDto,
  ) {
    return this.seriesService.previewCancelOccurrence(
      studioId,
      scheduledClassId,
      dto.scope,
    );
  }

  @Delete('occurrences/:scheduledClassId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: CancelSeriesOccurrenceDto,
    @Request() req: AuthRequest,
  ) {
    return this.seriesService.cancelOccurrence(
      studioId,
      scheduledClassId,
      dto.scope,
      req.user?.id ?? 'unknown',
      dto.cancelReason,
      dto.confirmReservations,
    );
  }
}
