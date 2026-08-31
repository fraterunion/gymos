import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  STRIPE_RENEWAL_EXTERNAL_CHANGE,
  type StripeRenewalSourceSurface,
} from './stripe-renewal-audit.constants';
import {
  describeStripeRenewalTimelineEvent,
  gymosRenewalActionForCancel,
  isGymosInitiatedStripeIdempotencyKey,
  readJsonMetadata,
  type ExternalRenewalAuditMetadata,
  type GymosRenewalAuditMetadata,
} from './stripe-renewal-audit.utils';

export type LogGymosRenewalChangeInput = {
  studioId: string;
  actorUserId: string;
  actorRole: string | null;
  memberUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  previousCancelAtPeriodEnd: boolean;
  newCancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  sourceSurface: StripeRenewalSourceSurface;
  stripeIdempotencyKey: string;
  stripeRequestId?: string | null;
  effectiveAt?: Date;
  tx?: Prisma.TransactionClient;
};

export type MaybeLogExternalRenewalChangeInput = {
  studioId: string;
  memberUserId: string;
  subscriptionId: string;
  stripeSubscriptionId: string;
  previousCancelAtPeriodEnd: boolean;
  newCancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  stripeEventId: string;
  stripeEventType: string;
  stripeRequestId: string | null;
  stripeIdempotencyKey: string | null;
  cancellationReason: string | null;
  cancellationFeedback: string | null;
  receivedAt?: Date;
};

/**
 * Correlation hierarchy (prefer unknown over false attribution):
 *
 * A. Stripe event.request.idempotency_key has a known GymOS prefix
 *    → skip EXTERNAL (GymOS-initiated mutation echoed by webhook)
 * B. Otherwise
 *    → STRIPE_EXTERNAL with actorUserId=null
 *
 * Temporal proximity to a prior GymOS audit is NEVER used to suppress EXTERNAL
 * or to invent a human actor. Ambiguous events stay unknown.
 */
@Injectable()
export class StripeRenewalAuditService {
  private readonly logger = new Logger(StripeRenewalAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logGymosRenewalChange(input: LogGymosRenewalChangeInput): Promise<void> {
    if (input.previousCancelAtPeriodEnd === input.newCancelAtPeriodEnd) {
      return;
    }
    const now = input.effectiveAt ?? new Date();
    const metadata: GymosRenewalAuditMetadata = {
      studioId: input.studioId,
      memberUserId: input.memberUserId,
      subscriptionId: input.subscriptionId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      origin: 'GYMOS',
      previousCancelAtPeriodEnd: input.previousCancelAtPeriodEnd,
      newCancelAtPeriodEnd: input.newCancelAtPeriodEnd,
      effectiveAt: now.toISOString(),
      currentPeriodEnd: input.currentPeriodEnd?.toISOString() ?? null,
      sourceSurface: input.sourceSurface,
      stripeIdempotencyKey: input.stripeIdempotencyKey,
      stripeRequestId: input.stripeRequestId ?? null,
      timestamp: now.toISOString(),
    };

    const client = input.tx ?? this.prisma;
    await client.auditLog.create({
      data: {
        studioId: input.studioId,
        actorUserId: input.actorUserId,
        action: gymosRenewalActionForCancel(input.newCancelAtPeriodEnd),
        targetUserId: input.memberUserId,
        entityType: 'Subscription',
        entityId: input.subscriptionId,
        metadata,
      },
    });
  }

  /**
   * Writes STRIPE_RENEWAL_EXTERNAL_CHANGE when CAPE flipped and Stripe did not
   * echo a known GymOS idempotency key. Idempotent on stripeEventId.
   */
  async maybeLogExternalRenewalChange(
    input: MaybeLogExternalRenewalChangeInput,
  ): Promise<'written' | 'skipped_no_transition' | 'skipped_gymos' | 'skipped_duplicate'> {
    if (input.previousCancelAtPeriodEnd === input.newCancelAtPeriodEnd) {
      return 'skipped_no_transition';
    }

    // Strong correlation only — never attribute via temporal heuristics.
    if (isGymosInitiatedStripeIdempotencyKey(input.stripeIdempotencyKey)) {
      return 'skipped_gymos';
    }

    const duplicate = await this.prisma.auditLog.findFirst({
      where: {
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        entityId: input.subscriptionId,
        metadata: { path: ['stripeEventId'], equals: input.stripeEventId },
      },
      select: { id: true },
    });
    if (duplicate) {
      return 'skipped_duplicate';
    }

    const receivedAt = input.receivedAt ?? new Date();
    const metadata: ExternalRenewalAuditMetadata = {
      studioId: input.studioId,
      memberUserId: input.memberUserId,
      subscriptionId: input.subscriptionId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      actorUserId: null,
      origin: 'STRIPE_EXTERNAL',
      previousCancelAtPeriodEnd: input.previousCancelAtPeriodEnd,
      newCancelAtPeriodEnd: input.newCancelAtPeriodEnd,
      stripeEventId: input.stripeEventId,
      stripeEventType: input.stripeEventType,
      stripeRequestId: input.stripeRequestId,
      stripeIdempotencyKey: input.stripeIdempotencyKey,
      cancellationReason: input.cancellationReason,
      cancellationFeedback: input.cancellationFeedback,
      currentPeriodEnd: input.currentPeriodEnd?.toISOString() ?? null,
      receivedAt: receivedAt.toISOString(),
    };

    await this.prisma.auditLog.create({
      data: {
        studioId: input.studioId,
        actorUserId: null,
        action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
        targetUserId: input.memberUserId,
        entityType: 'Subscription',
        entityId: input.subscriptionId,
        metadata,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'stripe_renewal_external_change_audited',
        stripeEventId: input.stripeEventId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        previousCancelAtPeriodEnd: input.previousCancelAtPeriodEnd,
        newCancelAtPeriodEnd: input.newCancelAtPeriodEnd,
      }),
    );

    return 'written';
  }

  /** Shared timeline serialization for Member 360 Historial. */
  describeTimelineEvent(
    action: string,
    metadata: unknown,
    actorName: string | null,
  ): { title: string; description: string; actor: string | null } {
    return describeStripeRenewalTimelineEvent({
      action,
      metadata: readJsonMetadata(metadata),
      actorName,
    });
  }
}
