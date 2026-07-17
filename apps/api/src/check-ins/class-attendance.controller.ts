import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CheckInsService } from './check-ins.service';
import { DESK_SCHEDULE_READ_ROLES, MANUAL_ATTENDANCE_ROLES } from '../auth/desk-roles';
import { ManualClassAttendanceDto } from './dto/manual-class-attendance.dto';

@Controller('studios/:studioId/classes/:classId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ClassAttendanceController {
  constructor(private readonly checkInsService: CheckInsService) {}

  @Get('attendance')
  @UseGuards(RolesGuard)
  @Roles(...DESK_SCHEDULE_READ_ROLES)
  list(@Param('studioId') studioId: string, @Param('classId') classId: string) {
    return this.checkInsService.listClassAttendance(studioId, classId);
  }

  @Post('manual-attendance')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(RolesGuard)
  @Roles(...MANUAL_ATTENDANCE_ROLES)
  registerManual(
    @Param('studioId') studioId: string,
    @Param('classId') classId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: ManualClassAttendanceDto,
  ) {
    return this.checkInsService.registerManualClassAttendance(
      studioId,
      classId,
      dto.memberId,
      actorUserId,
    );
  }
}
