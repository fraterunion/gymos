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
import { UpdateMembershipPlanDto } from './dto/update-membership-plan.dto';
import { MembershipPlansService } from './membership-plans.service';

@Controller('studios/:studioId/membership-plans')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class MembershipPlansController {
  constructor(
    private readonly membershipPlansService: MembershipPlansService,
    private readonly billingService: BillingService,
    private readonly enrollmentService: EnrollmentService,
  ) {}

  @Get()
  list(@Param('studioId') studioId: string) {
    return this.membershipPlansService.listActivePlans(studioId);
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
  create(@Param('studioId') studioId: string, @Body() dto: CreateMembershipPlanDto) {
    return this.membershipPlansService.createPlan(studioId, dto);
  }

  @Patch(':planId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  update(
    @Param('studioId') studioId: string,
    @Param('planId') planId: string,
    @Body() dto: UpdateMembershipPlanDto,
  ) {
    return this.membershipPlansService.updatePlan(studioId, planId, dto);
  }

  @Delete(':planId')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('studioId') studioId: string, @Param('planId') planId: string) {
    await this.membershipPlansService.softDeletePlan(studioId, planId);
  }
}
