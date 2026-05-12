import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { MembersService } from './members.service';

@Controller('studios/:studioId/members')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  list(@Param('studioId') studioId: string) {
    return this.membersService.listMembers(studioId);
  }

  /** Same payload as staff `GET …/:userId`, but only for the authenticated user (any studio role). */
  @Get('me')
  getMyProfile(@Param('studioId') studioId: string, @CurrentUser('sub') userId: string) {
    return this.membersService.getMemberProfile(studioId, userId);
  }

  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getOne(@Param('studioId') studioId: string, @Param('userId') userId: string) {
    return this.membersService.getMemberProfile(studioId, userId);
  }

  @Patch(':userId/role')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  updateRole(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.membersService.updateMemberRole(studioId, userId, actorUserId, dto);
  }
}
