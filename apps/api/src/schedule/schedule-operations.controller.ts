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
} from './dto/schedule-operations.dto';
import { ScheduleOperationsService } from './schedule-operations.service';

@Controller('studios/:studioId/schedule-operations')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class ScheduleOperationsController {
  constructor(private readonly operations: ScheduleOperationsService) {}

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
}
