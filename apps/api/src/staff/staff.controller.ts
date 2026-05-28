import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { AddStaffDto } from './dto/add-staff.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffService } from './staff.service';

@Controller('studios/:studioId/staff')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  // ── Directory ──────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  list(
    @Param('studioId') studioId: string,
    @Query() query: ListStaffQueryDto,
  ) {
    return this.staffService.listStaff(studioId, query);
  }

  // ── Instructors — MUST be before :userId to avoid param collision ──────────

  @Get('instructors')
  listInstructors(@Param('studioId') studioId: string) {
    return this.staffService.listInstructors(studioId);
  }

  // ── Single member ──────────────────────────────────────────────────────────

  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getOne(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.staffService.getStaffMember(studioId, userId);
  }

  // ── Add staff ──────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  addStaff(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: AddStaffDto,
  ) {
    return this.staffService.addStaff(studioId, actorUserId, dto);
  }

  // ── Update staff ───────────────────────────────────────────────────────────

  @Patch(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  updateStaff(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: UpdateStaffDto,
  ) {
    return this.staffService.updateStaff(studioId, actorUserId, userId, dto);
  }

  // ── Deactivate staff ───────────────────────────────────────────────────────

  @Delete(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  deactivateStaff(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.staffService.deactivateStaff(studioId, actorUserId, userId);
  }
}
