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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { StaffBookingDto } from './dto/staff-booking.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { UpdateSubscriptionStatusDto } from './dto/update-subscription-status.dto';
import { MembersService } from './members.service';

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '1', 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

function parseLimit(raw: string | undefined, def = 20): number {
  const n = parseInt(raw ?? String(def), 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, 100);
}

@Controller('studios/:studioId/members')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  // ── Directory ──────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
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

  // ── Single member ──────────────────────────────────────────────────────────

  @Get(':userId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getOne(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberProfile(studioId, userId);
  }

  // ── Bookings ───────────────────────────────────────────────────────────────

  @Get(':userId/bookings')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
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

  // ── Attendance ─────────────────────────────────────────────────────────────

  @Get(':userId/attendance')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
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

  // ── Payments ───────────────────────────────────────────────────────────────

  @Get(':userId/payments')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
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
  @Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
  getMemberSubscriptions(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.membersService.getMemberSubscriptions(studioId, userId);
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
