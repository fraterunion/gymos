import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleQueryDto } from '../schedule/dto/schedule-query.dto';
import { PublicDiscoveryService } from './public-discovery.service';

@Controller('public/studios')
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicDiscoveryController {
  constructor(private readonly publicDiscoveryService: PublicDiscoveryService) {}

  @Get(':slug')
  getStudioInfo(@Param('slug') slug: string) {
    return this.publicDiscoveryService.getStudioBySlug(slug);
  }

  @Get(':slug/schedule')
  getSchedule(@Param('slug') slug: string, @Query() query: ScheduleQueryDto) {
    return this.publicDiscoveryService.getPublicSchedule(slug, query);
  }

  @Get(':slug/membership-plans')
  getMembershipPlans(@Param('slug') slug: string) {
    return this.publicDiscoveryService.getPublicMembershipPlans(slug);
  }
}
