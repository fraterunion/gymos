import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { AnalyticsService } from './analytics.service';

function parseDays(raw: string | undefined, defaultDays: number): number {
  const n = parseInt(raw ?? '', 10);
  if (Number.isNaN(n) || n < 1) return defaultDays;
  return Math.min(n, 365);
}

@Controller('studios/:studioId/analytics')
@UseGuards(JwtAuthGuard, StudioMemberGuard, RolesGuard)
@Roles(Role.OWNER, Role.ADMIN, Role.STAFF)
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

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
}
