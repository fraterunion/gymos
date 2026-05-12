import { Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { RequestWithUser } from '../auth/interfaces/request-with-user.interface';
import { BillingService } from './billing.service';

@Controller('studios/:studioId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class StudioBillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('billing-portal')
  @HttpCode(HttpStatus.OK)
  async createBillingPortalSession(
    @Req() req: RequestWithUser,
    @Param('studioId') studioId: string,
  ): Promise<{ url: string }> {
    return this.billingService.createBillingPortalSessionForUser({
      userId: req.user.sub,
      studioId,
    });
  }
}
