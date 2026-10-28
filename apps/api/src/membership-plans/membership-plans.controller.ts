import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import type { RequestWithUser } from '../auth/interfaces/request-with-user.interface';
import { BillingService } from '../billing/billing.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { CreateMembershipPlanDto } from './dto/create-membership-plan.dto';
import {
  ApplyMembershipPriceChangeDto,
  PreviewMembershipPriceChangeDto,
  RetryMembershipPriceChangeDto,
} from './dto/apply-membership-price-change.dto';
import { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import { MembershipPlansService } from './membership-plans.service';
import { MembershipPriceChangeService } from './membership-price-change.service';

@Controller('studios/:studioId/membership-plans')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class MembershipPlansController {
  constructor(
    private readonly membershipPlansService: MembershipPlansService,
    private readonly priceChanges: MembershipPriceChangeService,
    private readonly billingService: BillingService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.membershipPlansService.listActivePlans(studioId);
  }

  @Get('billing-integrity')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  billingIntegrity(@Param('studioId') studioId: string) {
    return this.billingService.checkPlanPricingIntegrity(studioId);
  }

  /** MM-5: batched, server-computed CTA per plan for the CURRENT member (no N+1). */
  @Get('purchase-options')
  @UseGuards(RolesGuard)
  @Roles(Role.MEMBER)
  purchaseOptions(@Param('studioId') studioId: string, @Req() req: RequestWithUser) {
    return this.billingService.getMembershipPurchaseOptions(studioId, req.user.sub);
  }

  @Get(':planId/checkout-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.MEMBER)
  checkoutPreview(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.enrollmentService.calculateCheckoutQuote(req.user.sub, studioId, planId);
  }

  @Get(':planId/plan-change-preview')
  @UseGuards(RolesGuard)
  @Roles(Role.MEMBER)
  planChangePreview(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.billingService.getPlanChangePreview({
      userId: req.user.sub,
      studioId,
      planId,
    });
  }

  @Post(':planId/checkout')
  @UseGuards(RolesGuard)
  @Roles(Role.MEMBER)
  @HttpCode(HttpStatus.OK)
  createMemberCheckout(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.billingService.createMemberCheckoutSession({
      userId: req.user.sub,
      studioId,
      planId,
    });
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('studioId') studioId: string,
    @Body() dto: CreateMembershipPlanDto,
    @Req() req: RequestWithUser,
  ) {
    return this.membershipPlansService.createPlan(studioId, dto, req.user.sub);
  }

  @Get(':planId/configuration-history')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  configurationHistory(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
  ) {
    return this.membershipPlansService.listPlanConfigurationHistory(studioId, planId);
  }

  @Post(':planId/price-changes/preview')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  previewPriceChange(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Body() dto: PreviewMembershipPriceChangeDto,
  ) {
    return this.priceChanges.preview(studioId, planId, dto.newPriceCents);
  }

  @Get(':planId/price-changes')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  listPriceChanges(@Param('studioId') studioId: string, @Param('planId') planId: string) {
    return this.priceChanges.list(studioId, planId);
  }

  @Post(':planId/price-changes')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  applyPriceChange(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Body() dto: ApplyMembershipPriceChangeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.priceChanges.apply(studioId, planId, req.user.sub, dto);
  }

  @Post(':planId/price-changes/:changeId/retry')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  retryPriceChange(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Param('changeId') changeId: string,
    @Body() dto: RetryMembershipPriceChangeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.priceChanges.retry(studioId, planId, changeId, req.user.sub, dto.confirm);
  }

  @Patch(':planId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  update(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Body() dto: UpdateMembershipPlanDto,
    @Req() req: RequestWithUser,
  ) {
    return this.membershipPlansService.updatePlan(studioId, planId, dto, req.user.sub);
  }

  @Post(':planId/reconcile-stripe-price')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  reconcileStripePrice(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.membershipPlansService.reconcileStripeSalePrice(
      studioId,
      planId,
      req.user.sub,
    );
  }

  @Delete(':planId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Req() req: RequestWithUser,
  ) {
    await this.membershipPlansService.softDeletePlan(studioId, planId, req.user.sub);
  }
}
