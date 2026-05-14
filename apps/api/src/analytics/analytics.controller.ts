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
  getOverview(@Param('studioId') studioId: string) {
    return this.analyticsService.getOverview(studioId);
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
}
