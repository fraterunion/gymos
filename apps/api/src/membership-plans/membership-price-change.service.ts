import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MembershipPriceChangeItemStatus,
  MembershipPriceChangeScope,
  MembershipPriceChangeStatus,
  PaymentStatus,
  SubscriptionSource,
  SubscriptionStatus,
  type MembershipPriceChange,
  type MembershipPriceChangeItem,
} from '@prisma/client';
import { RENEWABLE_SUBSCRIPTION_STATUSES } from '../billing/subscription-lifecycle.constants';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { StripeService } from '../stripe/stripe.service';
import type { ApplyMembershipPriceChangeDto } from './dto/apply-membership-price-change.dto';
import { MembershipPlansService } from './membership-plans.service';
import { isStripeBackedPlan } from './membership-plan-stripe-price';

/** Existing members whose next charge can still change. Cancelled history is left alone. */
const AFFECTED_STATUSES: SubscriptionStatus[] = [
  ...RENEWABLE_SUBSCRIPTION_STATUSES,
  SubscriptionStatus.SCHEDULED,
];

/**
 * Stripe item swap that does not create a proration or an immediate invoice and
 * does not send billing_cycle_anchor, so the existing cycle stays where it is.
 * The next renewal invoice uses the new Price.
 */
export const STRIPE_UNPRORATED_PRICE_UPDATE = {
  proration_behavior: 'none' as const,
};

type PriceChangeWithItems = MembershipPriceChange & { items: MembershipPriceChangeItem[] };

type ResolvedSubscription = {
  id: string;
  userId: string;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  priceCents: number | null;
  stripeSubscriptionId: string | null;
  name: string;
  email: string;
  currentPriceCents: number;
  stripePriceId: string | null;
  stripeItemId: string | null;
  priceUnverified: boolean;
};

export type PriceChangeMemberPreview = {
  subscriptionId: string;
  userId: string;
  name: string;
  email: string;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  currentPriceCents: number;
  nextPriceCents: number;
  priceUnverified: boolean;
};

@Injectable()
export class MembershipPriceChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly plans: MembershipPlansService,
    private readonly audit: AuditService,
  ) {}

  async preview(studioId: string, planId: string, newPriceCents: number) {
    const plan = await this.requirePlan(studioId, planId);
    const members = await this.resolveAffected(studioId, plan);
    return {
      planId: plan.id,
      planName: plan.name,
      currency: plan.currency,
      oldPriceCents: plan.priceCents,
      newPriceCents,
      counts: {
        total: members.length,
        alreadyAtNewPrice: members.filter((m) => m.currentPriceCents === newPriceCents).length,
        wouldChange: members.filter((m) => m.currentPriceCents !== newPriceCents).length,
      },
      members: members.map((m) => ({
        subscriptionId: m.id,
        userId: m.userId,
        name: m.name,
        email: m.email,
        source: m.source,
        status: m.status,
        currentPriceCents: m.currentPriceCents,
        nextPriceCents: newPriceCents,
        priceUnverified: m.priceUnverified,
      })),
    };
  }

  async apply(studioId: string, planId: string, actorUserId: string, dto: ApplyMembershipPriceChangeDto) {
    if (dto.confirm !== true) {
      throw new BadRequestException('Confirma el cambio de precio antes de aplicarlo.');
    }
    const existing = await this.prisma.membershipPriceChange.findUnique({
      where: { studioId_idempotencyKey: { studioId, idempotencyKey: dto.idempotencyKey } },
      include: { items: true },
    });
    if (existing) {
      if (existing.membershipPlanId !== planId || existing.newPriceCents !== dto.newPriceCents || existing.scope !== dto.scope) {
        throw new ConflictException('Esta clave de idempotencia ya se usó para otro cambio de precio.');
      }
      // A selected-member change is also defined by WHO was selected, not just
      // plan, price and scope. Never silently reuse a prior selection when an
      // administrator resubmits the same key with a different member list.
      if (existing.scope === MembershipPriceChangeScope.SELECTED) {
        const recordedSelection = new Set(
          existing.items.filter((item) => item.applyNewPrice).map((item) => item.subscriptionId),
        );
        const attemptedSelection = new Set(dto.subscriptionIds ?? []);
        if (
          recordedSelection.size !== attemptedSelection.size ||
          [...attemptedSelection].some((id) => !recordedSelection.has(id))
        ) {
          throw new ConflictException(
            'Esta clave de idempotencia ya se usó con una selección diferente de miembros.',
          );
        }
      }
      if (existing.status === MembershipPriceChangeStatus.APPLYING) {
        return this.finish(await this.executePending(existing));
      }
      return this.toResult(existing, true);
    }

    const plan = await this.requirePlan(studioId, planId);
    if (dto.newPriceCents === plan.priceCents) {
      throw new BadRequestException('El precio nuevo es igual al precio actual del catálogo.');
    }
    const affected = await this.resolveAffected(studioId, plan);
    const selected = new Set(dto.subscriptionIds ?? []);
    if (dto.scope !== MembershipPriceChangeScope.SELECTED && selected.size > 0) {
      throw new BadRequestException(
        'Solo puedes seleccionar miembros cuando eliges la opción personalizada.',
      );
    }
    if (dto.scope === MembershipPriceChangeScope.SELECTED) {
      if (selected.size === 0) {
        throw new BadRequestException('Selecciona al menos un miembro, o elige aplicar el precio solo a futuros.');
      }
      const known = new Set(affected.map((row) => row.id));
      const unknown = [...selected].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException('La selección incluye suscripciones que no pertenecen a este plan.');
      }
    }

    let rotated: { previousStripePriceId: string | null; newStripePriceId: string; stripeProductId: string } | null = null;
    if (isStripeBackedPlan(plan)) {
      rotated = await this.plans.rotateStripeSalePrice({
        plan,
        next: {
          priceCents: dto.newPriceCents,
          currency: plan.currency,
          billingInterval: plan.billingInterval,
          entitlementDays: plan.entitlementDays,
        },
        source: 'membership_price_change',
      });
    }

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.membershipPlan.update({
        where: { id: plan.id },
        data: {
          priceCents: dto.newPriceCents,
          ...(rotated
            ? { stripeProductId: rotated.stripeProductId, stripePriceId: rotated.newStripePriceId }
            : {}),
        },
      });
      return tx.membershipPriceChange.create({
        data: {
          studioId,
          membershipPlanId: plan.id,
          actorUserId,
          scope: dto.scope,
          oldPriceCents: plan.priceCents,
          newPriceCents: dto.newPriceCents,
          currency: plan.currency,
          previousStripePriceId: rotated?.previousStripePriceId ?? plan.stripePriceId,
          newStripePriceId: rotated?.newStripePriceId ?? null,
          status: MembershipPriceChangeStatus.APPLYING,
          idempotencyKey: dto.idempotencyKey,
          confirmedAt: now,
          items: {
            create: affected.map((row) => {
              const applyNewPrice =
                dto.scope === MembershipPriceChangeScope.ALL_EXISTING ||
                (dto.scope === MembershipPriceChangeScope.SELECTED && selected.has(row.id));
              return {
                studioId,
                subscriptionId: row.id,
                userId: row.userId,
                source: row.source,
                applyNewPrice,
                oldPriceCents: row.currentPriceCents,
                newPriceCents: applyNewPrice ? dto.newPriceCents : row.currentPriceCents,
                previousStripePriceId: row.stripePriceId,
                status: MembershipPriceChangeItemStatus.PENDING,
              };
            }),
          },
        },
        include: { items: true },
      });
    });

    if (rotated?.previousStripePriceId && rotated.previousStripePriceId !== rotated.newStripePriceId) {
      try {
        await this.stripe.deactivatePrice(rotated.previousStripePriceId);
      } catch {
        // Catalog already points at the new Price. Leaving the old Price active
        // does not change existing subscriptions; reconciliation can archive it.
      }
    }

    const finished = await this.executePending(created);
    await this.audit.log({
      studioId,
      actorUserId,
      action: 'MEMBERSHIP_PRICE_CHANGE_APPLIED',
      entityType: 'membership_plan',
      entityId: plan.id,
      metadata: {
        priceChangeId: finished.id,
        scope: finished.scope,
        oldPriceCents: finished.oldPriceCents,
        newPriceCents: finished.newPriceCents,
        currency: finished.currency,
        previousStripePriceId: finished.previousStripePriceId,
        newStripePriceId: finished.newStripePriceId,
        status: finished.status,
        itemCount: finished.items.length,
      },
    });
    return this.toResult(finished, false);
  }

  async retry(studioId: string, planId: string, changeId: string, actorUserId: string, confirm: boolean) {
    if (confirm !== true) {
      throw new BadRequestException('Confirma el reintento antes de aplicarlo.');
    }
    const change = await this.prisma.membershipPriceChange.findFirst({
      where: { id: changeId, studioId, membershipPlanId: planId },
      include: { items: true },
    });
    if (!change) throw new NotFoundException('Price change not found');
    if (change.status === MembershipPriceChangeStatus.COMPLETED) return this.toResult(change, true);
    await this.prisma.membershipPriceChangeItem.updateMany({
      where: { priceChangeId: change.id, status: MembershipPriceChangeItemStatus.FAILED },
      data: { status: MembershipPriceChangeItemStatus.PENDING, error: null },
    });
    await this.prisma.membershipPriceChange.update({
      where: { id: change.id },
      data: { status: MembershipPriceChangeStatus.APPLYING, completedAt: null },
    });
    const reloaded = await this.prisma.membershipPriceChange.findUniqueOrThrow({
      where: { id: change.id },
      include: { items: true },
    });
    const finished = await this.executePending(reloaded);
    await this.audit.log({
      studioId,
      actorUserId,
      action: 'MEMBERSHIP_PRICE_CHANGE_RETRIED',
      entityType: 'membership_plan',
      entityId: planId,
      metadata: { priceChangeId: finished.id, status: finished.status },
    });
    return this.toResult(finished, false);
  }

  async list(studioId: string, planId: string) {
    await this.requirePlan(studioId, planId);
    const rows = await this.prisma.membershipPriceChange.findMany({
      where: { studioId, membershipPlanId: planId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { items: true },
    });
    return rows.map((row) => this.toResult(row, false));
  }

  private async executePending(change: PriceChangeWithItems): Promise<PriceChangeWithItems> {
    const targetPriceId = change.newStripePriceId;
    for (const item of change.items) {
      if (
        item.status === MembershipPriceChangeItemStatus.APPLIED ||
        item.status === MembershipPriceChangeItemStatus.SKIPPED
      ) {
        continue;
      }
      await this.executeItem(change, item, targetPriceId);
    }
    return this.finish(change);
  }

  private async executeItem(
    change: MembershipPriceChange,
    item: MembershipPriceChangeItem,
    targetPriceId: string | null,
  ) {
    const claimed = await this.prisma.membershipPriceChangeItem.updateMany({
      where: {
        id: item.id,
        status: { in: [MembershipPriceChangeItemStatus.PENDING, MembershipPriceChangeItemStatus.APPLYING] },
      },
      data: { status: MembershipPriceChangeItemStatus.APPLYING, error: null },
    });
    if (claimed.count !== 1) return;

    try {
      const subscription = await this.prisma.subscription.findFirst({
        where: { id: item.subscriptionId, studioId: change.studioId, membershipPlanId: change.membershipPlanId },
        select: { id: true, priceCents: true, stripeSubscriptionId: true, source: true, status: true },
      });
      if (!subscription || !AFFECTED_STATUSES.includes(subscription.status)) {
        await this.markItem(item.id, MembershipPriceChangeItemStatus.SKIPPED, 'La suscripción ya no está vigente.');
        return;
      }

      if (!item.applyNewPrice) {
        // Fer explicitly excluded this member (or chose FUTURE_ONLY).
        // Never rewrite their effective price from a potentially stale preview
        // snapshot. This path is intentionally ledger-only and never touches
        // the subscription or Stripe billing.
        await this.markItem(item.id, MembershipPriceChangeItemStatus.SKIPPED, null);
        return;
      }

      if (subscription.source === SubscriptionSource.STRIPE && subscription.stripeSubscriptionId) {
        if (!targetPriceId) {
          await this.markItem(item.id, MembershipPriceChangeItemStatus.FAILED, 'El plan no tiene un precio de Stripe para aplicar. No se modificó el cobro.');
          return;
        }
        const live = await this.readStripePrice(subscription.stripeSubscriptionId);
        if (!live.itemId) {
          await this.markItem(
            item.id,
            MembershipPriceChangeItemStatus.FAILED,
            live.error ?? 'No se pudo leer la suscripción en Stripe. No se modificó el cobro.',
          );
          return;
        }
        if (live.priceId !== targetPriceId) {
          await this.stripe.updateSubscription(
            subscription.stripeSubscriptionId,
            {
              items: [{ id: live.itemId, price: targetPriceId }],
              ...STRIPE_UNPRORATED_PRICE_UPDATE,
            },
            { idempotencyKey: `membership-price-change:${item.id}` },
          );
        }
        await this.prisma.subscription.update({
          where: { id: subscription.id },
          data: { priceCents: item.newPriceCents },
        });
        await this.prisma.membershipPriceChangeItem.update({
          where: { id: item.id },
          data: {
            status: MembershipPriceChangeItemStatus.APPLIED,
            appliedStripePriceId: targetPriceId,
            appliedAt: new Date(),
            error: null,
          },
        });
        return;
      }

      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { priceCents: item.newPriceCents },
      });
      await this.markItem(item.id, MembershipPriceChangeItemStatus.APPLIED, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Error desconocido de Stripe';
      await this.markItem(item.id, MembershipPriceChangeItemStatus.FAILED, message.slice(0, 500));
    }
  }

  private async finish(change: MembershipPriceChange): Promise<PriceChangeWithItems> {
    const items = await this.prisma.membershipPriceChangeItem.findMany({ where: { priceChangeId: change.id } });
    const failed = items.filter((item) => item.status === MembershipPriceChangeItemStatus.FAILED).length;
    const open = items.filter(
      (item) =>
        item.status === MembershipPriceChangeItemStatus.PENDING ||
        item.status === MembershipPriceChangeItemStatus.APPLYING,
    ).length;
    const status = open > 0
      ? MembershipPriceChangeStatus.APPLYING
      : failed === 0
        ? MembershipPriceChangeStatus.COMPLETED
        : failed === items.length
          ? MembershipPriceChangeStatus.FAILED
          : MembershipPriceChangeStatus.PARTIAL;
    return this.prisma.membershipPriceChange.update({
      where: { id: change.id },
      data: {
        status,
        completedAt: status === MembershipPriceChangeStatus.APPLYING ? null : new Date(),
      },
      include: { items: true },
    });
  }

  private async markItem(id: string, status: MembershipPriceChangeItemStatus, error: string | null) {
    await this.prisma.membershipPriceChangeItem.update({
      where: { id },
      data: {
        status,
        error,
        appliedAt: status === MembershipPriceChangeItemStatus.APPLIED || status === MembershipPriceChangeItemStatus.SKIPPED
          ? new Date()
          : null,
      },
    });
  }

  private async resolveAffected(
    studioId: string,
    plan: { id: string; priceCents: number },
  ): Promise<ResolvedSubscription[]> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        studioId,
        membershipPlanId: plan.id,
        status: { in: AFFECTED_STATUSES },
        user: { deletedAt: null },
      },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
        payments: {
          where: { status: PaymentStatus.SUCCEEDED },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { amountCents: true },
        },
      },
    });
    const resolved: ResolvedSubscription[] = [];
    for (const row of rows) {
      // A historical CASH payment is not proof of a contracted recurring
      // rate. Legacy CASH renewals use catalog until Fer explicitly opts into
      // grandfathering; Stripe preserves the live subscription item amount.
      let currentPriceCents = row.priceCents ??
        (row.source === SubscriptionSource.CASH
          ? plan.priceCents
          : (row.payments[0]?.amountCents ?? plan.priceCents));
      let stripePriceId: string | null = null;
      let stripeItemId: string | null = null;
      let priceUnverified = false;
      if (row.source === SubscriptionSource.STRIPE && row.stripeSubscriptionId) {
        const live = await this.readStripePrice(row.stripeSubscriptionId);
        stripePriceId = live.priceId;
        stripeItemId = live.itemId;
        if (live.unitAmount != null) currentPriceCents = live.unitAmount;
        else priceUnverified = true;
      }
      resolved.push({
        id: row.id,
        userId: row.userId,
        source: row.source,
        status: row.status,
        priceCents: row.priceCents,
        stripeSubscriptionId: row.stripeSubscriptionId,
        name: `${row.user.firstName} ${row.user.lastName}`.trim(),
        email: row.user.email,
        currentPriceCents,
        stripePriceId,
        stripeItemId,
        priceUnverified,
      });
    }
    return resolved;
  }

  private async readStripePrice(stripeSubscriptionId: string): Promise<{
    itemId: string | null;
    priceId: string | null;
    unitAmount: number | null;
    error?: string;
  }> {
    try {
      const subscription = await this.stripe.retrieveSubscription(stripeSubscriptionId);
      const item = subscription.items?.data?.[0];
      const price = item?.price;
      const priceId = typeof price === 'string' ? price : price?.id ?? null;
      let unitAmount = typeof price === 'string' ? null : price?.unit_amount ?? null;
      if (unitAmount == null && priceId) {
        const fetched = await this.stripe.retrievePrice(priceId);
        unitAmount = fetched.unit_amount ?? null;
      }
      return { itemId: item?.id ?? null, priceId, unitAmount };
    } catch (error) {
      return {
        itemId: null,
        priceId: null,
        unitAmount: null,
        error: error instanceof Error ? error.message : 'Stripe no respondió',
      };
    }
  }

  private async requirePlan(studioId: string, planId: string) {
    const plan = await this.prisma.membershipPlan.findFirst({
      where: { id: planId, studioId, deletedAt: null },
    });
    if (!plan) throw new NotFoundException('Membership plan not found');
    return plan;
  }

  private toResult(change: PriceChangeWithItems, idempotentReplay: boolean) {
    const counts = {
      applied: change.items.filter((item) => item.status === MembershipPriceChangeItemStatus.APPLIED).length,
      skipped: change.items.filter((item) => item.status === MembershipPriceChangeItemStatus.SKIPPED).length,
      failed: change.items.filter((item) => item.status === MembershipPriceChangeItemStatus.FAILED).length,
      pending: change.items.filter(
        (item) =>
          item.status === MembershipPriceChangeItemStatus.PENDING ||
          item.status === MembershipPriceChangeItemStatus.APPLYING,
      ).length,
    };
    return {
      id: change.id,
      status: change.status,
      scope: change.scope,
      oldPriceCents: change.oldPriceCents,
      newPriceCents: change.newPriceCents,
      currency: change.currency,
      previousStripePriceId: change.previousStripePriceId,
      newStripePriceId: change.newStripePriceId,
      confirmedAt: change.confirmedAt,
      completedAt: change.completedAt,
      createdAt: change.createdAt,
      counts,
      failures: change.items
        .filter((item) => item.status === MembershipPriceChangeItemStatus.FAILED)
        .map((item) => ({
          subscriptionId: item.subscriptionId,
          userId: item.userId,
          error: item.error,
        })),
      idempotentReplay,
    };
  }
}
