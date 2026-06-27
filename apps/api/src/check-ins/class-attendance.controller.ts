import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CheckInsService } from './check-ins.service';
import { DESK_SCHEDULE_READ_ROLES } from '../auth/desk-roles';

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
}
