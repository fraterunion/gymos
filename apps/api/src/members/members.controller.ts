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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CreateManualSubscriptionDto } from './dto/create-manual-subscription.dto';
import { CreateOperationalNoteDto } from './dto/create-operational-note.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { SetCancelAtPeriodEndDto } from './dto/set-cancel-at-period-end.dto';
import { StaffBookingDto } from './dto/staff-booking.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import { UpsertMemberCrmProfileDto } from './dto/upsert-member-crm-profile.dto';
import { MembersService } from './members.service';
import { MemberOperationalNotesService } from './member-operational-notes.service';
import { ProgressService } from './progress.service';
import type { LeaderboardPeriod } from './dto/member-progress.dto';

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '1', 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

function parseLimit(raw: string | undefined, def = 20): number {
  const n = parseInt(raw ?? String(def), 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, 100);
}

function parseLeaderboardPeriod(raw: string | undefined): LeaderboardPeriod {
  return raw === 'all_time' ? 'all_time' : 'month';
}

@Controller('studios/:studioId/members')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class MembersController {
  constructor(
    private readonly membersService: MembersService,
    private readonly operationalNotesService: MemberOperationalNotesService,
    private readonly progressService: ProgressService,
  ) {}

  // ── Directory ──────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  list(
    @Param('studioId') studioId: string,
    @Query() query: ListMembersQueryDto,
  ) {
    return this.membersService.listMembersEnriched(studioId, query);
  }

  // ── Self ───────────────────────────────────────────────────────────────────

  @Get('me')
  getMyProfile(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.membersService.getMemberProfile(studioId, userId);
  }

  @Get('me/progress')
  getMyProgress(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.progressService.getMemberProgress(studioId, userId);
  }

  @Get('leaderboard')
  getLeaderboard(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') callerId: string,
    @Query('period') period?: string,
  ) {
    return this.progressService.getLeaderboard(
      studioId,
      callerId,
      parseLeaderboardPeriod(period),
    );
  }

  // ── Single member ──────────────────────────────────────────────────────────

  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getOne(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberProfile(studioId, userId);
  }

  // ── Bookings ───────────────────────────────────────────────────────────────

  @Get(':userId/bookings')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberBookings(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.membersService.getMemberBookings(
      studioId,
      userId,
      parsePage(page),
      parseLimit(limit, 20),
    );
  }

  @Post(':userId/bookings')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  staffCreateBooking(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Body() dto: StaffBookingDto,
  ) {
    return this.membersService.staffCreateBooking(studioId, userId, dto.scheduledClassId);
  }

  @Delete(':userId/bookings/:bookingId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  staffCancelBooking(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Param('bookingId') bookingId: string,
  ) {
    return this.membersService.staffCancelBooking(studioId, userId, bookingId);
  }

  @Post(':userId/bookings/:bookingId/check-in')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  staffForceCheckIn(
    @Param('studioId') studioId: string,
    @Param('userId') _userId: string,
    @Param('bookingId') bookingId: string,
    @CurrentUser('sub') actorUserId: string,
  ) {
    return this.membersService.staffForceCheckIn(studioId, bookingId, actorUserId);
  }

  @Post(':userId/bookings/:bookingId/no-show')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  @HttpCode(HttpStatus.OK)
  staffMarkNoShow(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Param('bookingId') bookingId: string,
  ) {
    return this.membersService.staffMarkNoShow(studioId, userId, bookingId);
  }

  // ── Attendance ─────────────────────────────────────────────────────────────

  @Get(':userId/attendance')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberAttendance(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.membersService.getMemberAttendance(
      studioId,
      userId,
      parsePage(page),
      parseLimit(limit, 20),
    );
  }

  @Get(':userId/attendance-log')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getMemberAttendanceLog(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.membersService.getMemberAttendanceLog(
      studioId,
      userId,
      parsePage(page),
      parseLimit(limit, 20),
    );
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  @Get(':userId/payments')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberPayments(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.membersService.getMemberPayments(
      studioId,
      userId,
      parsePage(page),
      parseLimit(limit, 20),
    );
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  @Get(':userId/subscriptions')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberSubscriptions(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberSubscriptions(studioId, userId);
  }

  @Post(':userId/subscriptions')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  createManualSubscription(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Body() dto: CreateManualSubscriptionDto,
  ) {
    return this.membersService.createManualSubscription(
      studioId,
      userId,
      dto.planId,
      dto.stripeSubscriptionId,
    );
  }

  @Patch(':userId/subscriptions/:subscriptionId/status')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  updateSubscriptionStatus(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: UpdateSubscriptionStatusDto,
  ) {
    return this.membersService.updateMemberSubscription(studioId, userId, subscriptionId, dto);
  }

  @Patch(':userId/subscriptions/:subscriptionId/cancel-at-period-end')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  setCancelAtPeriodEnd(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Param('subscriptionId') subscriptionId: string,
    @Body() dto: SetCancelAtPeriodEndDto,
  ) {
    return this.membersService.setCancelAtPeriodEnd(studioId, userId, subscriptionId, dto.cancel);
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  @Get(':userId/timeline')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  getMemberTimeline(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberTimeline(studioId, userId);
  }

  // ── CRM profile ───────────────────────────────────────────────────────────

  @Get(':userId/profile')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getCrmProfile(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberCrmProfile(studioId, userId);
  }

  @Patch(':userId/profile')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  upsertCrmProfile(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Body() dto: UpsertMemberCrmProfileDto,
  ) {
    return this.membersService.upsertMemberCrmProfile(studioId, userId, dto);
  }

  // ── Operational notes (staff-only, not member-facing) ─────────────────────

  @Get(':userId/operational-notes')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF, Role.FRONT_DESK)
  listOperationalNotes(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
  ) {
    return this.operationalNotesService.listNotes(
      studioId,
      userId,
      parseLimit(limit, 50),
    );
  }

  @Post(':userId/operational-notes')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.FRONT_DESK)
  createOperationalNote(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @CurrentUser('sub') authorUserId: string,
    @Body() dto: CreateOperationalNoteDto,
  ) {
    return this.operationalNotesService.createNote(
      studioId,
      userId,
      authorUserId,
      dto,
    );
  }

  // ── Role ───────────────────────────────────────────────────────────────────

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
