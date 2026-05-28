import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role, SubscriptionStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { MembershipsService } from './memberships.service';
import { MembershipPlansService } from '../membership-plans/membership-plans.service';

@Controller('studios/:studioId/memberships')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN)
export class MembershipsController {
  constructor(
    private readonly membershipsService: MembershipsService,
    private readonly plansService: MembershipPlansService,
  ) {}

  @Get('plans')
  listPlans(
    @Param('studioId') studioId: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.plansService.listAllPlans(studioId, includeInactive === 'true');
  }

  @Get('overview')
  getOverview(@Param('studioId') studioId: string) {
    return this.membershipsService.getOverview(studioId);
  }

  @Get('subscriptions')
  listSubscriptions(
    @Param('studioId') studioId: string,
    @Query('status') status?: string,
    @Query('planId') planId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.membershipsService.listSubscriptions(studioId, {
      status: status as SubscriptionStatus | undefined,
      planId,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
