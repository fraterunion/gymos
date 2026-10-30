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
  Prisma,
  SubscriptionSource,
  SubscriptionStatus,
  type MembershipPriceChange,
  type MembershipPriceChangeItem,
} from '@prisma/client';
import type Stripe from 'stripe';
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

export type StripePriceShape = {
  unitAmount: number | null;
  currency: string | null;
  interval: string | null;
  intervalCount: number | null;
};

/**
 * Even with proration_behavior 'none', Stripe resets the billing anchor and invoices immediately
 * when an item moves to a price with a different interval, or between a free and a paid price.
 * Only a single-item subscription whose live price has the same currency and cadence as the
 * target, both non-zero, is swapped; anything else fails closed and Stripe is not touched.
 */
export function stripeSwapBlockReason(live: StripePriceShape & { itemCount: number }, target: StripePriceShape): string | null {
  if (live.itemCount !== 1) {
    return 'La suscripción de Stripe tiene varios conceptos. No se modificó el cobro.';
  }
  if (!live.unitAmount || !target.unitAmount) {
    return 'Cambiar desde o hacia un precio de $0 haría que Stripe cobre de inmediato. No se modificó el cobro.';
  }
  if (!live.currency || live.currency.toLowerCase() !== target.currency?.toLowerCase()) {
    return 'La moneda del cobro actual en Stripe no coincide con el nuevo precio. No se modificó el cobro.';
  }
  if (live.interval !== target.interval || (live.intervalCount ?? 1) !== (target.intervalCount ?? 1)) {
    return `El ciclo de cobro actual en Stripe (${live.intervalCount ?? 1} ${live.interval ?? '?'}) no coincide con el nuevo precio (${target.intervalCount ?? 1} ${target.interval ?? '?'}). Stripe facturaría de inmediato. No se modificó el cobro.`;
  }
  return null;
}

function priceShape(price: Stripe.Price | null | undefined): StripePriceShape {
  return {
    unitAmount: price?.unit_amount ?? null,
    currency: price?.currency ?? null,
    interval: price?.recurring?.interval ?? null,
    intervalCount: price?.recurring?.interval_count ?? null,
  };
}

type PriceChangeWithItems = MembershipPriceChange & { items: MembershipPriceChangeItem[] };

export const SUPERSEDED_PRICE_CHANGE_MESSAGE =
  'Este cambio de precio fue reemplazado por uno más reciente para este plan. No se reintenta para no sobrescribir la decisión nueva.';
export const CONCURRENT_PRICE_CHANGE_MESSAGE =
  'El precio de este plan cambió o hay otro cambio en curso. Recarga y revisa antes de confirmar.';
export const STALE_MEMBER_PRICE_MESSAGE =
  'El precio de este miembro cambió después de la vista previa. No se modificó su precio ni su cobro.';

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
    const existing = await this.findByKey(studioId, dto.idempotencyKey);
    if (existing) return this.replay(existing, planId, dto, { resume: true });

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
    let created: PriceChangeWithItems;
    try {
      created = await this.prisma.$transaction(async (tx) => {
      // Two administrators (or a double submit) racing on one plan: only one change may be in
      // flight, and the plan must still hold the price this request previewed. The conditional
      // update takes the plan row lock, so a concurrent transaction re-checks it after commit.
      const inFlight = await tx.membershipPriceChange.count({
        where: { studioId, membershipPlanId: plan.id, status: MembershipPriceChangeStatus.APPLYING },
      });
      if (inFlight > 0) throw new ConflictException(CONCURRENT_PRICE_CHANGE_MESSAGE);
      const claimed = await tx.membershipPlan.updateMany({
        where: { id: plan.id, priceCents: plan.priceCents, stripePriceId: plan.stripePriceId },
        data: {
          priceCents: dto.newPriceCents,
          ...(rotated
            ? { stripeProductId: rotated.stripeProductId, stripePriceId: rotated.newStripePriceId }
            : {}),
        },
      });
      if (claimed.count !== 1) throw new ConflictException(CONCURRENT_PRICE_CHANGE_MESSAGE);
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
    } catch (error) {
      const lostRace =
        error instanceof ConflictException ||
        (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002');
      if (!lostRace) throw error;
      await this.retireUnusedRotatedPrice(plan.id, rotated);
      // A double submit of the same request: answer with the change the other request recorded.
      const winner = await this.findByKey(studioId, dto.idempotencyKey);
      if (winner) return this.replay(winner, planId, dto, { resume: false });
      throw error instanceof ConflictException ? error : new ConflictException(CONCURRENT_PRICE_CHANGE_MESSAGE);
    }

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
    // A retry re-applies this change's price to its failed members. Once a newer change exists
    // for the plan, that would overwrite the newer decision for those members.
    if (await this.isSuperseded(change)) throw new ConflictException(SUPERSEDED_PRICE_CHANGE_MESSAGE);
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

  private findByKey(studioId: string, idempotencyKey: string) {
    return this.prisma.membershipPriceChange.findUnique({
      where: { studioId_idempotencyKey: { studioId, idempotencyKey } },
      include: { items: true },
    });
  }

  private async isSuperseded(change: MembershipPriceChange): Promise<boolean> {
    const newer = await this.prisma.membershipPriceChange.findFirst({
      where: { studioId: change.studioId, membershipPlanId: change.membershipPlanId, createdAt: { gt: change.createdAt } },
      select: { id: true },
    });
    return Boolean(newer);
  }

  /** Idempotent replay of an already-recorded change for the same key. */
  private async replay(
    existing: PriceChangeWithItems,
    planId: string,
    dto: ApplyMembershipPriceChangeDto,
    { resume }: { resume: boolean },
  ) {
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
    // Resume an interrupted change, unless a newer change for the plan exists (resuming would
    // overwrite it) or the other request is still executing it (resume: false).
    if (resume && existing.status === MembershipPriceChangeStatus.APPLYING && !(await this.isSuperseded(existing))) {
      // executePending already finalizes the ledger; return the same public
      // DTO shape as a new change, without double-finalizing or rotating the
      // catalog Price again on an idempotent request.
      return this.toResult(await this.executePending(existing), true);
    }
    return this.toResult(existing, true);
  }

  /** A request that lost a race may have created a new catalog Price nobody uses; archive it. */
  private async retireUnusedRotatedPrice(
    planId: string,
    rotated: { previousStripePriceId: string | null; newStripePriceId: string } | null,
  ) {
    if (!rotated || rotated.newStripePriceId === rotated.previousStripePriceId) return;
    const current = await this.prisma.membershipPlan.findFirst({ where: { id: planId }, select: { stripePriceId: true } });
    if (current?.stripePriceId === rotated.newStripePriceId) return;
    try {
      await this.stripe.deactivatePrice(rotated.newStripePriceId);
    } catch {
      // Best effort: an unused active Price bills nobody; reconciliation can archive it.
    }
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
    // Read the target price at most once per run, and only if a Stripe item actually needs a swap.
    let targetShape: Promise<StripePriceShape> | null = null;
    const loadTargetShape = () => {
      targetShape ??= this.stripe.retrievePrice(targetPriceId!).then(priceShape);
      return targetShape;
    };
    for (const item of change.items) {
      if (
        item.status === MembershipPriceChangeItemStatus.APPLIED ||
        item.status === MembershipPriceChangeItemStatus.SKIPPED
      ) {
        continue;
      }
      await this.executeItem(change, item, targetPriceId, loadTargetShape);
    }
    return this.finish(change);
  }

  private async executeItem(
    change: MembershipPriceChange,
    item: MembershipPriceChangeItem,
    targetPriceId: string | null,
    loadTargetShape: () => Promise<StripePriceShape>,
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
        // snapshot. This path never touches Stripe billing or an existing lock.
        // A row without any lock (created by a build that predates price locks,
        // e.g. during the deploy window) is pinned to the price it had before
        // this change, so being excluded can never mean renewing at the new price.
        if (subscription.priceCents == null) {
          await this.prisma.subscription.updateMany({
            where: { id: subscription.id, priceCents: null },
            data: { priceCents: item.oldPriceCents },
          });
        }
        await this.markItem(item.id, MembershipPriceChangeItemStatus.SKIPPED, null);
        return;
      }

      if (subscription.source === SubscriptionSource.STRIPE) {
        // Never treat a Stripe-backed subscription without a valid Stripe ID
        // as a CASH subscription. It would silently change only the local
        // renewal amount while the actual billed price stays unchanged.
        if (!subscription.stripeSubscriptionId) {
          await this.markItem(
            item.id,
            MembershipPriceChangeItemStatus.FAILED,
            'La membresía Stripe no tiene un identificador de suscripción válido. No se modificó el cobro ni el precio local.',
          );
          return;
        }
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
        // The member moved to another price after this change was previewed (a newer decision or
        // a manual change): never overwrite it from this older change.
        if (item.previousStripePriceId && live.priceId !== item.previousStripePriceId && live.priceId !== targetPriceId) {
          await this.markItem(item.id, MembershipPriceChangeItemStatus.FAILED, STALE_MEMBER_PRICE_MESSAGE);
          return;
        }
        if (live.priceId !== targetPriceId) {
          const blocked = stripeSwapBlockReason(live, await loadTargetShape());
          if (blocked) {
            await this.markItem(item.id, MembershipPriceChangeItemStatus.FAILED, blocked);
            return;
          }
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

      if (
        subscription.priceCents != null &&
        subscription.priceCents !== item.oldPriceCents &&
        subscription.priceCents !== item.newPriceCents
      ) {
        await this.markItem(item.id, MembershipPriceChangeItemStatus.FAILED, STALE_MEMBER_PRICE_MESSAGE);
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

  private async readStripePrice(stripeSubscriptionId: string): Promise<StripePriceShape & {
    itemId: string | null;
    priceId: string | null;
    itemCount: number;
    error?: string;
  }> {
    try {
      const subscription = await this.stripe.retrieveSubscription(stripeSubscriptionId);
      const items = subscription.items?.data ?? [];
      const item = items[0];
      const price = item?.price as Stripe.Price | string | undefined;
      const priceId = typeof price === 'string' ? price : price?.id ?? null;
      let expanded = typeof price === 'string' ? null : price ?? null;
      if (expanded?.unit_amount == null && priceId) {
        expanded = await this.stripe.retrievePrice(priceId);
      }
      return { itemId: item?.id ?? null, priceId, itemCount: items.length, ...priceShape(expanded) };
    } catch (error) {
      return {
        itemId: null,
        priceId: null,
        itemCount: 0,
        ...priceShape(null),
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
