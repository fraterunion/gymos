import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { AnalyticsService } from './analytics.service';
import { ExecutiveDashboardService } from './executive-dashboard.service';
import { FinancialActivityService } from './financial-activity.service';
import { MemberAnalyticsService } from './member-analytics.service';
import { RetentionAnalyticsService } from './retention-analytics.service';
import type {
  FinancialActivityEventType,
  FinancialActivityMethod,
  FinancialActivityStatus,
} from './financial-activity.types';

function parseDays(raw: string | undefined, defaultDays: number): number {
  const n = parseInt(raw ?? '', 10);
  if (Number.isNaN(n) || n < 1) return defaultDays;
  return Math.min(n, 365);
}

@Controller('studios/:studioId/analytics')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
export class AnalyticsController {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly executiveDashboardService: ExecutiveDashboardService,
    private readonly financialActivityService: FinancialActivityService,
    private readonly memberAnalyticsService: MemberAnalyticsService,
    private readonly retentionAnalyticsService: RetentionAnalyticsService,
  ) {}

  @Get('overview')
  getOverview(
    @Param('studioId') studioId: string,
    @Query('days') days?: string,
  ) {
    return this.analyticsService.getOverview(studioId, parseDays(days, 30));
  }

  @Get('trends')
  getTrends(
    @Param('studioId') studioId: string,
    @Query('days') days?: string,
  ) {
    return this.analyticsService.getTrends(studioId, parseDays(days, 7));
  }

  @Get('class-breakdown')
  getClassBreakdown(
    @Param('studioId') studioId: string,
    @Query('days') days?: string,
  ) {
    return this.analyticsService.getClassBreakdown(studioId, parseDays(days, 30));
  }

  @Get('business')
  getBusiness(
    @Param('studioId') studioId: string,
    @Query('days') days?: string,
  ) {
    return this.analyticsService.getBusinessAnalytics(studioId, parseDays(days, 30));
  }

  @Get('financial')
  getFinancial(
    @Param('studioId') studioId: string,
    @Query('period') period?: string,
  ) {
    const key = (['today', 'week', 'month', 'year'] as const).includes(
      period as 'today' | 'week' | 'month' | 'year',
    )
      ? (period as 'today' | 'week' | 'month' | 'year')
      : 'month';
    return this.analyticsService.getFinancialSummary(studioId, key);
  }

  @Get('briefing')
  getBriefing(@Param('studioId') studioId: string) {
    return this.analyticsService.getOwnerBriefing(studioId);
  }

  /** Member Intelligence — owner/admin only. */
  @Get('members/summary')
  @Roles(Role.OWNER, Role.ADMIN)
  getMemberAnalyticsSummary(
    @Param('studioId') studioId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.memberAnalyticsService.getSummary(studioId, period, from, to);
  }

  @Get('members/activity')
  @Roles(Role.OWNER, Role.ADMIN)
  getMemberAnalyticsActivity(
    @Param('studioId') studioId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('frequencyPopulation') frequencyPopulation?: string,
  ) {
    const population = frequencyPopulation === 'all' ? 'all' : 'active';
    return this.memberAnalyticsService.getActivity(studioId, period, from, to, population);
  }

  @Get('members/:userId')
  @Roles(Role.OWNER, Role.ADMIN)
  getMemberAnalyticsDetail(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.memberAnalyticsService.getMemberDetail(studioId, userId, period, from, to);
  }

  @Get('members')
  @Roles(Role.OWNER, Role.ADMIN)
  getMemberAnalyticsList(
    @Param('studioId') studioId: string,
    @Query('period') period?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    const parsedPage = parseInt(page ?? '', 10);
    const parsedLimit = parseInt(limit ?? '', 10);
    return this.memberAnalyticsService.listMembers(studioId, {
      period,
      from,
      to,
      search,
      sort,
      order,
      status,
      page: Number.isNaN(parsedPage) ? undefined : parsedPage,
      limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
    });
  }

  /** Analytics 1.1 — attendance retention (owner/admin only). */
  @Get('retention/summary')
  @Roles(Role.OWNER, Role.ADMIN)
  getRetentionSummary(@Param('studioId') studioId: string) {
    return this.retentionAnalyticsService.getSummary(studioId);
  }

  @Get('retention/activity')
  @Roles(Role.OWNER, Role.ADMIN)
  getRetentionActivity(@Param('studioId') studioId: string) {
    return this.retentionAnalyticsService.getActivity(studioId);
  }

  @Get('retention/members/:userId')
  @Roles(Role.OWNER, Role.ADMIN)
  getRetentionMemberDetail(
    @Param('studioId') studioId: string,
    @Param('userId') userId: string,
  ) {
    return this.retentionAnalyticsService.getMemberDetail(studioId, userId);
  }

  @Get('retention/members')
  @Roles(Role.OWNER, Role.ADMIN)
  getRetentionMembers(
    @Param('studioId') studioId: string,
    @Query('search') search?: string,
    @Query('health') health?: string,
    @Query('movement') movement?: string,
    @Query('entitlement') entitlement?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedPage = parseInt(page ?? '', 10);
    const parsedLimit = parseInt(limit ?? '', 10);
    const entitlementKey =
      entitlement === 'entitled' || entitlement === 'lapsed' || entitlement === 'all'
        ? entitlement
        : 'all';
    return this.retentionAnalyticsService.listMembers(studioId, {
      search,
      health,
      movement,
      entitlement: entitlementKey,
      sort,
      order,
      page: Number.isNaN(parsedPage) ? undefined : parsedPage,
      limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
    });
  }

  /** Executive Dashboard 2.0 — owner/admin financial intelligence only. */
  @Get('executive')
  @Roles(Role.OWNER, Role.ADMIN)
  getExecutive(@Param('studioId') studioId: string) {
    return this.executiveDashboardService.getExecutiveDashboard(studioId);
  }

  /** Paginated payment and billing activity — owner/admin only. */
  @Get('financial-activity')
  @Roles(Role.OWNER, Role.ADMIN)
  getFinancialActivity(
    @Param('studioId') studioId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('method') method?: string,
    @Query('eventType') eventType?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('memberSearch') memberSearch?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedLimit = parseInt(limit ?? '', 10);
    return this.financialActivityService.getFinancialActivity(studioId, {
      from,
      to,
      method: parseActivityMethod(method),
      eventType: parseActivityEventType(eventType),
      status: parseActivityStatus(status),
      category: parseActivityCategory(category),
      memberSearch,
      cursor,
      limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
    });
  }
}

const ACTIVITY_METHODS = ['stripe', 'cash', 'terminal', 'transfer', 'other', 'all'] as const;
const ACTIVITY_STATUSES = ['collected', 'pending', 'failed', 'refunded', 'cancelled', 'all'] as const;
const ACTIVITY_CATEGORIES = ['all', 'stripe', 'cash', 'renewals', 'failed', 'refunds'] as const;
const ACTIVITY_EVENT_TYPES = [
  'new_membership',
  'membership_renewal',
  'one_time_payment',
  'payment_failed',
  'refund',
  'trial_started',
  'subscription_cancelled',
  'all',
] as const;

function parseActivityMethod(raw: string | undefined): FinancialActivityMethod | 'all' | undefined {
  if (!raw) return undefined;
  return (ACTIVITY_METHODS as readonly string[]).includes(raw)
    ? (raw as FinancialActivityMethod | 'all')
    : undefined;
}

function parseActivityStatus(raw: string | undefined): FinancialActivityStatus | 'all' | undefined {
  if (!raw) return undefined;
  return (ACTIVITY_STATUSES as readonly string[]).includes(raw)
    ? (raw as FinancialActivityStatus | 'all')
    : undefined;
}

function parseActivityCategory(raw: string | undefined) {
  if (!raw) return undefined;
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as (typeof ACTIVITY_CATEGORIES)[number])
    : undefined;
}

function parseActivityEventType(raw: string | undefined): FinancialActivityEventType | 'all' | undefined {
  if (!raw) return undefined;
  return (ACTIVITY_EVENT_TYPES as readonly string[]).includes(raw)
    ? (raw as FinancialActivityEventType | 'all')
    : undefined;
}
