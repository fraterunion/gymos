import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PaymentMethod,
  PaymentStatus,
  Role,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { WaiverService } from '../waiver/waiver.service';
import { AuditService } from './audit.service';
import type { CreateOfflineSubscriptionDto } from './dto/create-offline-subscription.dto';
import type { CreateWalkInMemberDto } from './dto/create-walk-in-member.dto';
import {
  canCreateWalkInMember,
  canIssueStaffCheckout,
  canRecordCashPayment,
} from './sales-permissions';
import { SalesSettingsService } from './sales-settings.service';

const memberUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  createdAt: true,
} as const;

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly billingService: BillingService,
    private readonly waiverService: WaiverService,
    private readonly auditService: AuditService,
    private readonly salesSettingsService: SalesSettingsService,
  ) {}

  private async getActorMembership(studioId: string, actorUserId: string) {
    const m = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!m) throw new ForbiddenException();
    return m;
  }

  private async assertTargetMember(studioId: string, userId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null, role: Role.MEMBER },
      include: { user: { select: memberUserSelect } },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    if (membership.user && (await this.isUserDeleted(userId))) {
      throw new NotFoundException('Member not found');
    }
    return membership;
  }

  private async isUserDeleted(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { deletedAt: true },
    });
    return Boolean(user?.deletedAt);
  }

  async createWalkInMember(
    studioId: string,
    actorUserId: string,
    dto: CreateWalkInMemberDto,
  ) {
    const actor = await this.getActorMembership(studioId, actorUserId);
    const settings = await this.salesSettingsService.getSettings(studioId);

    if (!canCreateWalkInMember(actor.role, settings)) {
      throw new ForbiddenException('Insufficient permissions to create members');
    }

    const email = dto.email.trim().toLowerCase();

    const existingUser = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await this.authService.hashPassword(dto.temporaryPassword);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          firstName: dto.firstName.trim(),
          lastName: dto.lastName.trim(),
          phone: dto.phone?.trim() || null,
          passwordHash,
        },
        select: memberUserSelect,
      });

      const membership = await tx.studioMembership.create({
        data: {
          studioId,
          userId: user.id,
          role: Role.MEMBER,
        },
        select: {
          id: true,
          role: true,
          createdAt: true,
        },
      });

      return { user, membership };
    });

    await this.auditService.log({
      studioId,
      actorUserId,
      action: 'MEMBER_CREATED',
      targetUserId: result.user.id,
      entityType: 'StudioMembership',
      entityId: result.membership.id,
      metadata: { email: result.user.email, source: 'walk_in' },
    });

    return {
      user: result.user,
      membership: result.membership,
    };
  }

  async createStaffCheckoutSession(
    studioId: string,
    actorUserId: string,
    targetUserId: string,
    planId: string,
  ) {
    const actor = await this.getActorMembership(studioId, actorUserId);
    const settings = await this.salesSettingsService.getSettings(studioId);

    if (!canIssueStaffCheckout(actor.role, settings)) {
      throw new ForbiddenException('Insufficient permissions to issue checkout links');
    }

    await this.assertTargetMember(studioId, targetUserId);

    const { checkoutUrl } = await this.billingService.createStaffInitiatedCheckoutSession({
      actorUserId,
      targetUserId,
      studioId,
      planId,
    });

    await this.auditService.log({
      studioId,
      actorUserId,
      action: 'STAFF_CHECKOUT_CREATED',
      targetUserId,
      entityType: 'MembershipPlan',
      entityId: planId,
      metadata: { checkoutUrl },
    });

    return { checkoutUrl };
  }

  async createOfflineSubscription(
    studioId: string,
    actorUserId: string,
    targetUserId: string,
    dto: CreateOfflineSubscriptionDto,
  ) {
    const actor = await this.getActorMembership(studioId, actorUserId);
    const settings = await this.salesSettingsService.getSettings(studioId);

    if (!canRecordCashPayment(actor.role, settings)) {
      throw new ForbiddenException('Insufficient permissions to record cash payments');
    }

    await this.assertTargetMember(studioId, targetUserId);
    await this.waiverService.assertMemberWaiverAccepted(studioId, targetUserId);

    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: dto.planId, studioId, deletedAt: null, active: true },
    });
    if (!plan) {
      throw new NotFoundException('Membership plan not found');
    }

    if (dto.amountCents <= 0) {
      throw new BadRequestException('Amount must be greater than zero');
    }

    if (dto.amountCents !== plan.priceCents) {
      if (actor.role !== Role.OWNER) {
        throw new BadRequestException(
          'Amount must match plan price unless overridden by an owner',
        );
      }
      if (!dto.priceOverrideNote?.trim()) {
        throw new BadRequestException(
          'priceOverrideNote is required when amount differs from plan price',
        );
      }
    }

    const periodStart = dto.periodStart ? new Date(dto.periodStart) : new Date();
    const periodEnd = dto.periodEnd
      ? new Date(dto.periodEnd)
      : this.defaultPeriodEnd(periodStart, plan.billingInterval);

    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Invalid period dates');
    }
    if (periodEnd <= periodStart) {
      throw new BadRequestException('periodEnd must be after periodStart');
    }

    const combinedNotes = [dto.notes?.trim(), dto.priceOverrideNote?.trim()]
      .filter(Boolean)
      .join(' | ') || null;

    const result = await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.create({
        data: {
          studioId,
          userId: targetUserId,
          membershipPlanId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          source: SubscriptionSource.CASH,
          stripeSubscriptionId: null,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
          createdByUserId: actorUserId,
          notes: combinedNotes,
        },
        include: {
          membershipPlan: {
            select: {
              id: true,
              name: true,
              billingInterval: true,
              priceCents: true,
              currency: true,
            },
          },
        },
      });

      const payment = await tx.payment.create({
        data: {
          studioId,
          userId: targetUserId,
          subscriptionId: subscription.id,
          membershipPlanId: plan.id,
          amountCents: dto.amountCents,
          currency: plan.currency,
          status: PaymentStatus.SUCCEEDED,
          paymentMethod: PaymentMethod.CASH,
          recordedByUserId: actorUserId,
          notes: dto.notes?.trim() || null,
          paidAt: new Date(),
        },
      });

      return { subscription, payment };
    });

    await this.auditService.log({
      studioId,
      actorUserId,
      action: 'CASH_SUBSCRIPTION_CREATED',
      targetUserId,
      entityType: 'Subscription',
      entityId: result.subscription.id,
      metadata: {
        planId: plan.id,
        amountCents: dto.amountCents,
        paymentId: result.payment.id,
      },
    });

    return result;
  }

  private defaultPeriodEnd(
    start: Date,
    billingInterval: 'MONTHLY' | 'YEARLY' | 'WEEKLY',
  ): Date {
    const end = new Date(start);
    if (billingInterval === 'MONTHLY') {
      end.setMonth(end.getMonth() + 1);
    } else if (billingInterval === 'YEARLY') {
      end.setFullYear(end.getFullYear() + 1);
    } else if (billingInterval === 'WEEKLY') {
      end.setDate(end.getDate() + 7);
    }
    return end;
  }
}
