import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { StudioMemberGuard } from '../auth/guards/studio-member.guard';
import { CreateOfflineSubscriptionDto } from './dto/create-offline-subscription.dto';
import { CreateStaffCheckoutDto } from './dto/create-staff-checkout.dto';
import { CreateWalkInMemberDto } from './dto/create-walk-in-member.dto';
import { SALES_STAFF_ROLES } from './sales-permissions';
import { SalesSettingsService } from './sales-settings.service';
import { SalesService } from './sales.service';

@Controller('studios/:studioId')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly salesSettingsService: SalesSettingsService,
  ) {}

  @Get('sales/settings')
  @UseGuards(RolesGuard)
  @Roles(...SALES_STAFF_ROLES)
  getSalesSettings(@Param('studioId') studioId: string) {
    return this.salesSettingsService.getSettings(studioId);
  }
}

@Controller('studios/:studioId/members')
@UseGuards(JwtAuthGuard, StudioMemberGuard)
export class SalesMembersController {
  constructor(private readonly salesService: SalesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles(...SALES_STAFF_ROLES)
  @HttpCode(HttpStatus.CREATED)
  createWalkInMember(
    @Param('studioId') studioId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: CreateWalkInMemberDto,
  ) {
    return this.salesService.createWalkInMember(studioId, actorUserId, dto);
  }

  @Post(':userId/checkout-sessions')
  @UseGuards(RolesGuard)
  @Roles(...SALES_STAFF_ROLES)
  @HttpCode(HttpStatus.CREATED)
  createStaffCheckout(
    @Param('studioId') studioId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: CreateStaffCheckoutDto,
  ) {
    return this.salesService.createStaffCheckoutSession(
      studioId,
      actorUserId,
      targetUserId,
      dto.planId,
    );
  }

  @Post(':userId/offline-subscriptions')
  @UseGuards(RolesGuard)
  @Roles(Role.OWNER, Role.ADMIN, Role.FRONT_DESK)
  @HttpCode(HttpStatus.CREATED)
  createOfflineSubscription(
    @Param('studioId') studioId: string,
    @Param('userId') targetUserId: string,
    @CurrentUser('sub') actorUserId: string,
    @Body() dto: CreateOfflineSubscriptionDto,
  ) {
    return this.salesService.createOfflineSubscription(
      studioId,
      actorUserId,
      targetUserId,
      dto,
    );
  }
}
