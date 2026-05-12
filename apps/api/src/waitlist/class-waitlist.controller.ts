import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WaitlistService } from './waitlist.service';

@Controller('studios/:studioId/classes/:classId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class ClassWaitlistController {
  constructor(private readonly waitlistService: WaitlistService) {}

  @Post('waitlist')
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('studioId') studioId: string,
    @Param('classId') classId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.waitlistService.joinWaitlist(studioId, classId, userId);
  }

  @Get('waitlist')
  @UseGuards(RolesGuard)
  @Roles(Role.STAFF, Role.INSTRUCTOR, Role.ADMIN, Role.OWNER)
  async listForClass(@Param('studioId') studioId: string, @Param('classId') classId: string) {
    return this.waitlistService.listClassWaitlist(studioId, classId);
  }
}
