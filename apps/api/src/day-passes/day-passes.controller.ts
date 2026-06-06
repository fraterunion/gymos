import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { DayPassesService } from './day-passes.service';

@Controller('studios/:studioId/day-passes')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class DayPassesController {
  constructor(private readonly dayPassesService: DayPassesService) {}

  @Get('me')
  listMine(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.dayPassesService.listMyDayPasses(studioId, userId);
  }
}
