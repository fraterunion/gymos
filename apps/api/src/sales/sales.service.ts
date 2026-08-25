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
  Prisma,
  Role,
  SubscriptionEndReason,
  SubscriptionSource,
  SubscriptionStatus,
} from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { BillingService, type MembershipCheckoutResponse } from '../billing/billing.service';
import { StripeToCashTransitionService } from '../billing/stripe-to-cash-transition.service';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../billing/subscription-lifecycle.constants';
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

/** Partial unique index subscriptions_one_active_per_user_per_studio_idx. */
const ACTIVE_MEMBERSHIP_CONFLICT_MESSAGE =
  'Ya existe una membresía activa para este miembro. Revisa su membresía e inténtalo de nuevo.';

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
    private readonly stripeToCash: StripeToCashTransitionService,
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
  ): Promise<MembershipCheckoutResponse> {
    const actor = await this.getActorMembership(studioId, actorUserId);
    const settings = await this.salesSettingsService.getSettings(studioId);

    if (!canIssueStaffCheckout(actor.role, settings)) {
      throw new ForbiddenException('Insufficient permissions to issue checkout links');
    }

    await this.assertTargetMember(studioId, targetUserId);

    const result = await this.billingService.createStaffInitiatedCheckoutSession({
      actorUserId,
      targetUserId,
      studioId,
      planId,
    });

    await this.auditService.log({
      studioId,
      actorUserId,
      action: result.action === 'plan_changed' ? 'MEMBERSHIP_PLAN_CHANGED' : 'STAFF_CHECKOUT_CREATED',
      targetUserId,
      entityType: 'MembershipPlan',
      entityId: planId,
      metadata:
        result.action === 'plan_changed'
          ? {
              effective: result.effective,
              previousPlanId: result.previousPlan.id,
              newPlanId: result.newPlan.id,
            }
          : { checkoutUrl: result.url },
    });

    return result;
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

    const combinedNotes =
      [dto.notes?.trim(), dto.priceOverrideNote?.trim()].filter(Boolean).join(' | ') ||
      null;

    // Missed-webhook safety: activate any due scheduled cash before new assignment.
    await this.stripeToCash.reconcileScheduledCashForMember(studioId, targetUserId);

    const stripeSub = await this.stripeToCash.findPrimaryStripeSubscription(studioId, targetUserId);

    if (stripeSub?.stripeSubscriptionId) {
      if (!dto.stripeResolution) {
        const pending = await this.stripeToCash.findPendingScheduledCash(studioId, targetUserId);
        throw this.stripeToCash.buildConflictException(
          stripeSub,
          actor.role,
          pending?.id ?? null,
        );
      }
      this.stripeToCash.assertCanResolveStripe(actor.role);

      if (dto.stripeResolution === 'cancel_at_period_end') {
        const scheduled = await this.stripeToCash.scheduleCashAtStripePeriodEnd({
          studioId,
          actorUserId,
          targetUserId,
          plan,
          amountCents: dto.amountCents,
          notes: combinedNotes,
          defaultPeriodEnd: (start, interval) => this.defaultPeriodEnd(start, interval),
        });

        await this.auditService.log({
          studioId,
          actorUserId,
          action: 'STRIPE_TO_CASH_PERIOD_END_SCHEDULED',
          targetUserId,
          entityType: 'Subscription',
          entityId: scheduled.subscription.id,
          metadata: {
            resolution: 'period_end',
            oldSubscriptionId: scheduled.stripe.localSubscriptionId,
            newSubscriptionId: scheduled.subscription.id,
            oldSource: 'STRIPE',
            newSource: 'CASH',
            planId: plan.id,
            planName: plan.name,
            stripeSubscriptionId: scheduled.stripe.stripeSubscriptionId,
            effectiveAt: scheduled.subscription.currentPeriodStart?.toISOString() ?? null,
            amountCents: dto.amountCents,
            paymentId: scheduled.payment.id,
          },
        });

        return {
          subscription: scheduled.subscription,
          payment: scheduled.payment,
        };
      }

      // cancel_immediately — Stripe cancel first, then ACTIVE cash below.
      await this.stripeToCash.cancelStripeImmediately({
        studioId,
        userId: targetUserId,
      });
    }

    const now = new Date();
    // Fixed-duration CASH (entitlementDays set): renew in place + new entitlement cycle.
    // Interval CASH (entitlementDays null): successor row — must supersede before create
    // to satisfy subscriptions_one_active_per_user_per_studio_idx.
    //
    // Early same-plan interval renewal therefore starts at `now` (prepaid remainder is
    // not preserved): a future-dated ACTIVE successor would violate the one-ACTIVE
    // partial unique index. Fixed-duration early renewal preserves prepaid time only
    // when clients omit periodStart (queues after current entitlement end).
    const renewableCashSubscription =
      plan.entitlementDays != null
        ? await this.prisma.subscription.findFirst({
            where: {
              studioId,
              userId: targetUserId,
              membershipPlanId: plan.id,
              source: SubscriptionSource.CASH,
              status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
            },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              entitlementEndsAt: true,
            },
          })
        : null;

    let periodStart = dto.periodStart ? new Date(dto.periodStart) : now;
    if (renewableCashSubscription && !dto.periodStart) {
      const currentEnd =
        renewableCashSubscription.entitlementEndsAt ??
        renewableCashSubscription.currentPeriodEnd;
      if (currentEnd && currentEnd > periodStart) periodStart = currentEnd;
    }
    const periodEnd = dto.periodEnd
      ? new Date(dto.periodEnd)
      : plan.entitlementDays != null
        ? new Date(periodStart.getTime() + plan.entitlementDays * 86_400_000)
        : this.defaultPeriodEnd(periodStart, plan.billingInterval);

    // For fixed-duration plans (e.g. Booty Lab 45-day), anchor the GymOS entitlement
    // window at periodStart — the same formula the Stripe webhook uses for online purchases.
    const entitlementEndsAt =
      plan.entitlementDays != null
        ? new Date(periodStart.getTime() + plan.entitlementDays * 86_400_000)
        : null;

    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) {
      throw new BadRequestException('Invalid period dates');
    }
    if (periodEnd <= periodStart) {
      throw new BadRequestException('periodEnd must be after periodStart');
    }

    const planInclude = {
      membershipPlan: {
        select: {
          id: true,
          name: true,
          billingInterval: true,
          priceCents: true,
          currency: true,
        },
      },
    } as const;

    let result: {
      subscription: {
        id: string;
        status: SubscriptionStatus;
        source: SubscriptionSource;
        currentPeriodStart: Date | null;
        currentPeriodEnd: Date | null;
        membershipPlan: {
          id: string;
          name: string;
          billingInterval: string;
          priceCents: number;
          currency: string;
        };
      };
      payment: { id: string; amountCents: number; status: PaymentStatus; paymentMethod: PaymentMethod };
    };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        let subscription;

        if (renewableCashSubscription) {
          subscription = await tx.subscription.update({
            where: { id: renewableCashSubscription.id },
            data: {
              status: SubscriptionStatus.ACTIVE,
              currentPeriodStart:
                periodStart <= now
                  ? periodStart
                  : renewableCashSubscription.currentPeriodStart,
              currentPeriodEnd: entitlementEndsAt!,
              entitlementEndsAt: entitlementEndsAt!,
            },
            include: planInclude,
          });
        } else {
          // Supersede first so at most one ACTIVE row exists under the partial unique index.
          const toSupersede = await tx.subscription.findMany({
            where: {
              studioId,
              userId: targetUserId,
              status: { in: RENEWABLE_SUBSCRIPTION_STATUSES },
            },
            select: { id: true, membershipPlanId: true },
          });

          for (const row of toSupersede) {
            await tx.subscription.update({
              where: { id: row.id },
              data: {
                status: SubscriptionStatus.CANCELED,
                endReason:
                  row.membershipPlanId === plan.id
                    ? SubscriptionEndReason.SUPERSEDED_RENEWAL
                    : SubscriptionEndReason.SUPERSEDED_PLAN_CHANGE,
              },
            });
          }

          subscription = await tx.subscription.create({
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
              ...(entitlementEndsAt !== null ? { entitlementEndsAt } : {}),
            },
            include: planInclude,
          });

          if (toSupersede.length > 0) {
            await tx.subscription.updateMany({
              where: { id: { in: toSupersede.map((r) => r.id) } },
              data: { supersededBySubscriptionId: subscription.id },
            });
          }

          // Link Stripe rows canceled for offline assignment (payment-method change).
          await tx.subscription.updateMany({
            where: {
              studioId,
              userId: targetUserId,
              endReason: SubscriptionEndReason.SUPERSEDED_PAYMENT_METHOD,
              supersededBySubscriptionId: null,
              id: { not: subscription.id },
            },
            data: { supersededBySubscriptionId: subscription.id },
          });
        }

        if (plan.entitlementDays != null) {
          await tx.membershipEntitlementCycle.create({
            data: {
              studioId,
              userId: targetUserId,
              subscriptionId: subscription.id,
              membershipPlanId: plan.id,
              startsAt: periodStart,
              endsAt: entitlementEndsAt!,
              creditLimit: plan.classCredits,
              source: SubscriptionSource.CASH,
            },
          });
        }

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
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(ACTIVE_MEMBERSHIP_CONFLICT_MESSAGE);
      }
      throw e;
    }

    const auditAction =
      dto.stripeResolution === 'cancel_immediately'
        ? 'STRIPE_TO_CASH_IMMEDIATE'
        : 'CASH_SUBSCRIPTION_CREATED';

    await this.auditService.log({
      studioId,
      actorUserId,
      action: auditAction,
      targetUserId,
      entityType: 'Subscription',
      entityId: result.subscription.id,
      metadata: {
        planId: plan.id,
        amountCents: dto.amountCents,
        paymentId: result.payment.id,
        ...(dto.stripeResolution === 'cancel_immediately'
          ? {
              resolution: 'immediate',
              oldSource: 'STRIPE',
              newSource: 'CASH',
            }
          : {}),
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
