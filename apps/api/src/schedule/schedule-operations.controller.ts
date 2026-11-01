import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import {
  BulkScheduleOperationDto,
  DuplicateClassDto,
  DuplicateWeekDto,
  MatchingDatesCancelExecuteDto,
  MatchingDatesCancelPreviewDto,
  RangeCancelExecuteDto,
  RangeCancelPreviewDto,
} from './dto/schedule-operations.dto';
import { ScheduleMatchingDatesCancellationService } from './schedule-matching-dates-cancellation.service';
import { ScheduleOperationsService } from './schedule-operations.service';
import { ScheduleRangeCancellationService } from './schedule-range-cancellation.service';

@Controller('studios/:studioId/schedule-operations')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class ScheduleOperationsController {
  constructor(
    private readonly operations: ScheduleOperationsService,
    private readonly rangeCancellation: ScheduleRangeCancellationService,
    private readonly matchingDatesCancellation: ScheduleMatchingDatesCancellationService,
  ) {}

  @Post('duplicate-week/preview')
  previewDuplicateWeek(
    @Param('studioId') studioId: string,
    @Body() dto: DuplicateWeekDto,
  ) {
    return this.operations.previewDuplicateWeek(studioId, dto);
  }

  @Post('duplicate-week')
  @HttpCode(HttpStatus.OK)
  executeDuplicateWeek(
    @Param('studioId') studioId: string,
    @Body() dto: DuplicateWeekDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.operations.executeDuplicateWeek(studioId, dto, actorUserId);
  }

  @Post('classes/:scheduledClassId/duplicate/preview')
  previewDuplicateClass(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: DuplicateClassDto,
  ) {
    return this.operations.previewDuplicateClass(studioId, scheduledClassId, dto);
  }

  @Post('classes/:scheduledClassId/duplicate')
  @HttpCode(HttpStatus.OK)
  executeDuplicateClass(
    @Param('studioId') studioId: string,
    @Param('scheduledClassId') scheduledClassId: string,
    @Body() dto: DuplicateClassDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.operations.executeDuplicateClass(
      studioId,
      scheduledClassId,
      dto,
      actorUserId,
    );
  }

  @Post('bulk/preview')
  previewBulk(
    @Param('studioId') studioId: string,
    @Body() dto: BulkScheduleOperationDto,
  ) {
    return this.operations.previewBulk(studioId, dto);
  }

  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  executeBulk(
    @Param('studioId') studioId: string,
    @Body() dto: BulkScheduleOperationDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.operations.executeBulk(studioId, dto, actorUserId);
  }

  @Post('range-cancel/preview')
  @HttpCode(HttpStatus.OK)
  previewRangeCancel(
    @Param('studioId') studioId: string,
    @Body() dto: RangeCancelPreviewDto,
  ) {
    return this.rangeCancellation.preview(studioId, dto);
  }

  @Post('range-cancel')
  @HttpCode(HttpStatus.OK)
  executeRangeCancel(
    @Param('studioId') studioId: string,
    @Body() dto: RangeCancelExecuteDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.rangeCancellation.execute(studioId, dto, actorUserId);
  }

  @Post('matching-dates-cancel/preview')
  @HttpCode(HttpStatus.OK)
  previewMatchingDatesCancel(
    @Param('studioId') studioId: string,
    @Body() dto: MatchingDatesCancelPreviewDto,
  ) {
    return this.matchingDatesCancellation.preview(studioId, dto);
  }

  @Post('matching-dates-cancel')
  @HttpCode(HttpStatus.OK)
  executeMatchingDatesCancel(
    @Param('studioId') studioId: string,
    @Body() dto: MatchingDatesCancelExecuteDto,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.matchingDatesCancellation.execute(studioId, dto, actorUserId);
  }
}
