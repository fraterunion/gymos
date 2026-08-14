import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { RequestWithUser } from '../auth/interfaces/request-with-user.interface';
import { BillingService } from './billing.service';
import { SubscriptionReconciliationService, type StudioReconciliationAudit } from './subscription-reconciliation.service';

@Controller('studios/:studioId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class StudioBillingController {
  constructor(
    private readonly billingService: BillingService,
    private readonly reconciliation: SubscriptionReconciliationService,
  ) {}

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

  /**
   * Read-only billing reconciliation audit for OWNER/ADMIN.
   * Returns subscription health summary + any actionable findings.
   * Never mutates Stripe or local DB.
   */
  @Get('billing/reconciliation-audit')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  async reconciliationAudit(
    @Param('studioId') studioId: string,
  ): Promise<StudioReconciliationAudit> {
    return this.reconciliation.auditStudio(studioId);
  }
}
