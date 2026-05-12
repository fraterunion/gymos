import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WaitlistService } from './waitlist.service';

@Controller('studios/:studioId/waitlist')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class StudioWaitlistController {
  constructor(private readonly waitlistService: WaitlistService) {}

  @Get('me')
  listMine(@Param('studioId') studioId: string, @CurrentUser('sub') userId: string) {
    return this.waitlistService.listMyWaitlist(studioId, userId);
  }

  @Post(':entryId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(
    @Param('studioId') studioId: string,
    @Param('entryId') entryId: string,
    @CurrentUser('sub') userId: string,
  ): Promise<void> {
    await this.waitlistService.cancelWaitlistEntry(studioId, entryId, userId);
  }
}
