import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DayPassStatus, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';
import { MEMBER_ERRORS } from '../member-facing/member-errors';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { WaiverService } from '../waiver/waiver.service';
import {
  activateDayPassFromSucceededPaymentIntent,
  snapshotFromStripePaymentIntent,
  type ActivationOutcome,
} from './day-pass-activation';
import { logDayPassEvent } from './day-pass-events';
import { DayPassSettingsService } from './day-pass-settings.service';
import type { DayPassResponseDto } from './dto/day-pass-response.dto';

// Must match the Stripe SDK version used by the mobile React Native client.
// Update this if the mobile Stripe SDK is upgraded.
const STRIPE_MOBILE_API_VERSION = '2025-08-27.basil';

/**
 * A slot row that has no PaymentIntent yet and was touched more recently than this is a
 * creation still in flight (the PaymentIntent call is running in another request). Older
 * than this, the request that created it died before attaching an intent, and the slot is
 * safe to take over.
 */
export const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Furthest date a member may buy a pass for, in studio-local days from today. Today is the
 * only product the apps sell; the horizon exists so a skewed device clock or a malformed key
 * can never mint a pass for an arbitrary future day.
 */
export const MAX_DAYS_AHEAD = 30;

/**
 * PaymentIntent statuses in which PaymentSheet can still confirm with the ORIGINAL
 * client_secret. A `canceled` intent can never be confirmed again; `processing` /
 * `succeeded` must not be re-presented (that would be a double charge); `requires_action`
 * (a 3DS challenge left mid-way) is replaced rather than re-presented so a member can never
 * loop on a stuck authentication session.
 */
const REPRESENTABLE_PI_STATUSES: ReadonlySet<string> = new Set([
  'requires_payment_method',
  'requires_confirmation',
]);

export type DayPassPaymentSheetResponse = {
  dayPassId: string;
  paymentIntentClientSecret: string;
  customerId: string;
  ephemeralKeySecret: string;
  publishableKey: string;
};

type SlotRow = {
  id: string;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  stripePaymentIntentId: string | null;
  attemptCount: number;
  lastAttemptAt: Date | null;
  createdAt: Date;
};

const SLOT_SELECT = {
  id: true,
  status: true,
  priceCents: true,
  currency: true,
  stripePaymentIntentId: true,
  attemptCount: true,
  lastAttemptAt: true,
  createdAt: true,
} as const;

const DAY_PASS_DTO_SELECT = {
  id: true,
  validForDate: true,
  status: true,
  priceCents: true,
  currency: true,
  createdAt: true,
} as const;

type CheckoutContext = {
  studioId: string;
  userId: string;
  validForDate: string;
  validForDateUtc: Date;
  priceCents: number;
  currency: string;
  stripePriceId: string;
  customerId: string;
};

/**
 * Day Pass purchase lifecycle.
 *
 * Ownership rule: ONLY `status = ACTIVE` is a purchased pass, and only Stripe can set it
 * (see day-pass-activation.ts). A PENDING row is an open checkout attempt for that calendar
 * day — the slot the unique index protects — and is never treated as ownership: a member who
 * abandons PaymentSheet, gets declined, or loses connectivity simply retries, and the retry
 * REUSES the slot (re-presenting the same PaymentIntent while Stripe still allows it, or
 * replacing it otherwise). Stripe is consulted live on every retry, so a payment that did
 * succeed without its webhook arriving yet is activated here rather than blocked.
 */
@Injectable()
export class DayPassesService {
  private readonly logger = new Logger(DayPassesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    private readonly waiverService: WaiverService,
    private readonly dayPassSettings: DayPassSettingsService,
  ) {}

  /** Purchased passes only. Open attempts are never shown as if they were passes. */
  async listMyDayPasses(studioId: string, userId: string): Promise<DayPassResponseDto[]> {
    return this.prisma.dayPass.findMany({
      where: { studioId, userId, status: DayPassStatus.ACTIVE },
      select: DAY_PASS_DTO_SELECT,
      orderBy: { validForDate: 'desc' },
    });
  }

  async createDayPassPaymentSheet(params: {
    studioId: string;
    userId: string;
    /** Omitted → today in the studio timezone (server-decided). */
    validForDate?: string | null;
  }): Promise<DayPassPaymentSheetResponse> {
    const { studioId, userId } = params;
    await this.waiverService.assertMemberWaiverAccepted(studioId, userId);

    const sale = await this.dayPassSettings.resolveCheckoutSalePrice(studioId, userId);
    const { priceCents, currency, stripePriceId } = sale;

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const todayKey = getStudioLocalDateKey(new Date(), studio.timezone);
    const validForDate = params.validForDate ?? todayKey;
    if (validForDate < todayKey) {
      throw new BadRequestException(MEMBER_ERRORS.dayPassDateInPast);
    }
    const validForDateUtc = studioLocalDateKeyToUtcAnchor(validForDate, studio.timezone);
    // Canonical-form guard: '2026-13-01' matches the DTO regex and would silently normalise
    // to 2027-01-01; the round trip must reproduce the key exactly.
    if (getStudioLocalDateKey(validForDateUtc, studio.timezone) !== validForDate) {
      throw new BadRequestException('validForDate must be a valid calendar date');
    }
    const horizonUtc = studioLocalDateKeyToUtcAnchor(todayKey, studio.timezone);
    horizonUtc.setUTCDate(horizonUtc.getUTCDate() + MAX_DAYS_AHEAD);
    if (validForDateUtc.getTime() > horizonUtc.getTime()) {
      throw new BadRequestException(`validForDate must be within ${MAX_DAYS_AHEAD} days`);
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true, stripeCustomerId: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const customer = await this.stripe.createOrRetrieveCustomer({
      email: user.email,
      name: `${user.firstName} ${user.lastName}`.trim(),
      existingStripeCustomerId: user.stripeCustomerId,
      metadata: { gymosUserId: user.id },
    });
    if (customer.id !== user.stripeCustomerId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    const ctx: CheckoutContext = {
      studioId,
      userId,
      validForDate,
      validForDateUtc,
      priceCents,
      currency,
      stripePriceId,
      customerId: customer.id,
    };

    const slot = await this.prisma.dayPass.findUnique({
      where: { studioId_userId_validForDate: { studioId, userId, validForDate: validForDateUtc } },
      select: SLOT_SELECT,
    });

    return slot ? this.resumeSlot(slot, ctx) : this.startFreshAttempt(ctx);
  }

  /**
   * Server-verified post-payment sync. PaymentSheet told the CLIENT the payment succeeded; the
   * client is never trusted for that, so this asks Stripe for the intent's live status and
   * activates through the same routine the webhook uses. Makes the pass visible immediately
   * instead of after webhook latency, and covers a webhook that is delayed or misconfigured.
   */
  async syncDayPassFromStripe(params: {
    studioId: string;
    userId: string;
    dayPassId: string;
  }): Promise<DayPassResponseDto> {
    const { studioId, userId, dayPassId } = params;
    const row = await this.prisma.dayPass.findFirst({
      where: { id: dayPassId, studioId, userId },
      select: { ...DAY_PASS_DTO_SELECT, stripePaymentIntentId: true },
    });
    if (!row) {
      throw new NotFoundException('Day Pass not found');
    }
    if (row.status === DayPassStatus.ACTIVE || !row.stripePaymentIntentId) {
      return toDto(row);
    }

    const pi = await this.stripe.retrievePaymentIntent(row.stripePaymentIntentId);
    if (pi.status === 'succeeded') {
      await this.activateFromStripe(pi);
    } else {
      await this.prisma.dayPass.updateMany({
        where: { id: dayPassId, status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: pi.id },
        data: {
          lastStripeStatus: pi.status,
          lastPaymentErrorCode: pi.last_payment_error?.code ?? null,
          lastPaymentDeclineCode: pi.last_payment_error?.decline_code ?? null,
        },
      });
    }

    const fresh = await this.prisma.dayPass.findUniqueOrThrow({
      where: { id: dayPassId },
      select: DAY_PASS_DTO_SELECT,
    });
    return toDto(fresh);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Attempt slot handling
  // ───────────────────────────────────────────────────────────────────────────

  private async startFreshAttempt(ctx: CheckoutContext): Promise<DayPassPaymentSheetResponse> {
    const now = new Date();
    let slotId: string;
    try {
      const created = await this.prisma.dayPass.create({
        data: {
          studioId: ctx.studioId,
          userId: ctx.userId,
          validForDate: ctx.validForDateUtc,
          priceCents: ctx.priceCents,
          currency: ctx.currency,
          status: DayPassStatus.PENDING,
          attemptCount: 1,
          lastAttemptAt: now,
        },
        select: { id: true },
      });
      slotId = created.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // A concurrent request for the same day won the slot a moment ago (double tap).
        // It will finish attaching its PaymentIntent; the member's next tap reuses it.
        this.logConflict(ctx, 'attempt_in_progress', null);
        throw new ConflictException(MEMBER_ERRORS.dayPassAttemptInProgress);
      }
      throw err;
    }

    let paymentIntent: Stripe.PaymentIntent;
    try {
      paymentIntent = await this.createIntentForSlot(slotId, 1, ctx);
    } catch (err) {
      // No intent exists for the row, so nothing is lost by releasing the slot; keeping it
      // would only make the next tap wait out IN_FLIGHT_GRACE_MS.
      await this.releaseIntentlessSlot(slotId);
      throw err;
    }

    // Compare-and-swap: bind only if nobody else attached an intent meanwhile (a takeover of
    // this slot after IN_FLIGHT_GRACE_MS, e.g. during a very slow Stripe call).
    const bound = await this.prisma.dayPass.updateMany({
      where: { id: slotId, stripePaymentIntentId: null },
      data: { stripePaymentIntentId: paymentIntent.id, lastStripeStatus: paymentIntent.status },
    });
    if (bound.count === 0) {
      await this.throwSlotMovedConflict(slotId, ctx, paymentIntent.id);
    }
    logDayPassEvent(this.logger, 'DAY_PASS_CHECKOUT_CREATED', {
      ...this.eventFields(ctx, slotId),
      stripePaymentIntentId: paymentIntent.id,
      attemptCount: 1,
      source: 'api',
    });
    // From here the row carries a live intent: a failure below (ephemeral key, config) leaves
    // the slot in place and the next attempt simply re-presents that intent.
    return this.buildSheetResponse(slotId, paymentIntent, ctx);
  }

  private async resumeSlot(slot: SlotRow, ctx: CheckoutContext): Promise<DayPassPaymentSheetResponse> {
    if (slot.status === DayPassStatus.ACTIVE) {
      this.logConflict(ctx, 'already_owned', slot.id);
      throw new ConflictException(MEMBER_ERRORS.dayPassAlreadyOwned);
    }

    if (slot.status === DayPassStatus.REFUNDED) {
      // Refunds are an operator action (no code sets REFUNDED). The refunded intent stays
      // `succeeded` at Stripe, so re-opening this slot automatically could let a late event
      // re-activate it on refunded money. Same outcome as before this change: staff decides.
      this.logConflict(ctx, 'refunded_slot', slot.id);
      throw new ConflictException(MEMBER_ERRORS.dayPassNeedsSupport);
    }

    if (!slot.stripePaymentIntentId) {
      const startedAt = slot.lastAttemptAt ?? slot.createdAt;
      if (Date.now() - startedAt.getTime() < IN_FLIGHT_GRACE_MS) {
        this.logConflict(ctx, 'attempt_in_progress', slot.id);
        throw new ConflictException(MEMBER_ERRORS.dayPassAttemptInProgress);
      }
      // The request that created the slot died before attaching an intent. Take it over.
      return this.replaceAttempt(slot, ctx, null, 'orphaned_slot');
    }

    let pi: Stripe.PaymentIntent | null;
    try {
      pi = await this.stripe.retrievePaymentIntent(slot.stripePaymentIntentId);
    } catch (err) {
      if (isStripeResourceMissing(err)) {
        pi = null;
      } else {
        throw err;
      }
    }
    if (!pi) {
      return this.replaceAttempt(slot, ctx, slot.stripePaymentIntentId, 'intent_missing_in_stripe');
    }

    switch (pi.status) {
      case 'succeeded':
        // Paid, but the webhook has not landed (or was never subscribed). Stripe is the
        // authority: activate now, then report ownership rather than a stale attempt.
        return this.resolvePaidIntent(pi, slot, ctx);
      case 'processing':
      case 'requires_capture':
        return this.resolveProcessingIntent(pi, slot, ctx);
      case 'canceled':
        return this.replaceAttempt(slot, ctx, pi.id, 'intent_canceled');
      case 'requires_action':
        return this.replaceAttempt(slot, ctx, pi.id, 'intent_requires_action', pi);
      default: {
        if (this.canRepresent(pi, slot, ctx)) {
          return this.reuseAttempt(slot, ctx, pi);
        }
        // Price/currency/customer no longer match the intent (e.g. the studio rotated the
        // price between attempts). Retire the stale intent so it can never be paid at the
        // old amount, then mint a fresh one for this slot.
        return this.replaceAttempt(slot, ctx, pi.id, 'intent_stale', pi);
      }
    }
  }

  private async resolvePaidIntent(pi: Stripe.PaymentIntent, slot: SlotRow, ctx: CheckoutContext): Promise<never> {
    const outcome = await this.activateFromStripe(pi);
    if (outcome.outcome === 'ignored') {
      // Stripe says succeeded but activation refused (e.g. the charge was refunded at Stripe).
      // Neither "owned" nor "buy again" is safe to assert automatically.
      this.logConflict(ctx, `paid_intent_not_activated:${outcome.reason}`, slot.id);
      throw new ConflictException(MEMBER_ERRORS.dayPassNeedsSupport);
    }
    this.logConflict(ctx, 'already_owned_reconciled', slot.id);
    throw new ConflictException(MEMBER_ERRORS.dayPassAlreadyOwned);
  }

  private async resolveProcessingIntent(pi: Stripe.PaymentIntent, slot: SlotRow, ctx: CheckoutContext): Promise<never> {
    await this.prisma.dayPass.updateMany({
      where: { id: slot.id, status: { not: DayPassStatus.ACTIVE }, stripePaymentIntentId: pi.id },
      data: { lastStripeStatus: pi.status },
    });
    this.logConflict(ctx, 'payment_processing', slot.id);
    throw new ConflictException(MEMBER_ERRORS.dayPassPaymentProcessing);
  }

  /**
   * Before REPLACING a still-live intent, Stripe must confirm it is dead. A cancel can fail
   * because the member just paid it (3DS finishing, a second open sheet) or because Stripe
   * had a transient error; minting a replacement then would leave two chargeable intents.
   * So a failed cancel is resolved from the intent's LIVE status, and a replacement is only
   * minted once the old intent is canceled (or gone).
   */
  private async retireIntentOrResolve(pi: Stripe.PaymentIntent, slot: SlotRow, ctx: CheckoutContext): Promise<void> {
    try {
      const canceled = await this.stripe.cancelPaymentIntent(pi.id, 'abandoned');
      if (canceled.status === 'canceled') return;
    } catch (err) {
      this.logger.warn(
        `Day Pass: cancel of PaymentIntent ${pi.id} before replacement failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let live: Stripe.PaymentIntent;
    try {
      live = await this.stripe.retrievePaymentIntent(pi.id);
    } catch (err) {
      if (isStripeResourceMissing(err)) return;
      throw err;
    }
    switch (live.status) {
      case 'canceled':
        return;
      case 'succeeded':
        return this.resolvePaidIntent(live, slot, ctx);
      case 'processing':
      case 'requires_capture':
        return this.resolveProcessingIntent(live, slot, ctx);
      default:
        // Still confirmable and we could not cancel it: do not mint a second one now.
        this.logConflict(ctx, 'retire_intent_failed', slot.id);
        throw new ConflictException(MEMBER_ERRORS.dayPassAttemptInProgress);
    }
  }

  private canRepresent(pi: Stripe.PaymentIntent, slot: SlotRow, ctx: CheckoutContext): boolean {
    if (!REPRESENTABLE_PI_STATUSES.has(pi.status)) return false;
    if (!pi.client_secret) return false;
    if (pi.amount !== ctx.priceCents) return false;
    if ((pi.currency ?? '').toLowerCase() !== ctx.currency.toLowerCase()) return false;
    const piCustomer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id ?? null;
    if (piCustomer !== ctx.customerId) return false;
    const md = (pi.metadata ?? {}) as Record<string, string>;
    if (md['type'] !== 'day_pass' || md['dayPassId'] !== slot.id) return false;
    return true;
  }

  private async reuseAttempt(
    slot: SlotRow,
    ctx: CheckoutContext,
    pi: Stripe.PaymentIntent,
  ): Promise<DayPassPaymentSheetResponse> {
    const attemptCount = slot.attemptCount + 1;
    // Compare-and-swap on (not ACTIVE, same intent): if the member paid this very intent between
    // our Stripe read and now (webhook raced us), the slot is ACTIVE and must not be touched.
    const swapped = await this.prisma.dayPass.updateMany({
      where: {
        id: slot.id,
        status: { not: DayPassStatus.ACTIVE },
        stripePaymentIntentId: pi.id,
        attemptCount: slot.attemptCount,
      },
      data: {
        status: DayPassStatus.PENDING,
        attemptCount,
        lastAttemptAt: new Date(),
        lastStripeStatus: pi.status,
        expiredAt: null,
      },
    });
    if (swapped.count === 0) {
      await this.throwSlotMovedConflict(slot.id, ctx, null);
    }
    logDayPassEvent(this.logger, 'DAY_PASS_CHECKOUT_REUSED', {
      ...this.eventFields(ctx, slot.id),
      stripePaymentIntentId: pi.id,
      stripeStatus: pi.status,
      attemptCount,
      source: 'api',
    });
    logDayPassEvent(this.logger, 'DAY_PASS_RETRY', { ...this.eventFields(ctx, slot.id), attemptCount, reason: 'reuse' });
    return this.buildSheetResponse(slot.id, pi, ctx);
  }

  /**
   * @param retire a still-live intent that must be confirmed dead at Stripe before a replacement
   *   is minted. It is retired only AFTER this request wins the attempt reservation, so a
   *   concurrent request that is re-presenting the same intent can never hand the member an
   *   intent this request just cancelled (whichever commits first makes the other's CAS miss).
   */
  private async replaceAttempt(
    slot: SlotRow,
    ctx: CheckoutContext,
    previousIntentId: string | null,
    reason: string,
    retire?: Stripe.PaymentIntent,
  ): Promise<DayPassPaymentSheetResponse> {
    const attemptCount = slot.attemptCount + 1;
    // Reserve the attempt number BEFORE calling Stripe. The idempotency key is derived from it,
    // and Stripe stores the first outcome of a key (including a 5xx) for ~24 h: if a create
    // fails, the next retry must use a NEW number or it would replay the stored failure all
    // day. The reservation is itself a compare-and-swap, so concurrent replacers cannot both
    // proceed (the loser gets 409 attempt-in-progress and mints nothing).
    const reserved = await this.prisma.dayPass.updateMany({
      where: {
        id: slot.id,
        status: { not: DayPassStatus.ACTIVE },
        stripePaymentIntentId: slot.stripePaymentIntentId,
        attemptCount: slot.attemptCount,
      },
      data: { attemptCount, lastAttemptAt: new Date() },
    });
    if (reserved.count === 0) {
      await this.throwSlotMovedConflict(slot.id, ctx, null);
    }
    if (retire) {
      // Throws (409 owned / processing / in progress) unless Stripe confirms the old intent is
      // dead; the attempt number reserved above is then simply skipped, which is harmless.
      await this.retireIntentOrResolve(retire, slot, ctx);
    }
    const paymentIntent = await this.createIntentForSlot(slot.id, attemptCount, ctx);
    // Compare-and-swap on (not ACTIVE, intent and attempt unchanged since we reserved). If the
    // old intent got paid meanwhile, or the slot moved, we must not overwrite: cancel the intent
    // we just minted (it was never presented) and report the slot's real state.
    const swapped = await this.prisma.dayPass.updateMany({
      where: {
        id: slot.id,
        status: { not: DayPassStatus.ACTIVE },
        stripePaymentIntentId: slot.stripePaymentIntentId,
        attemptCount,
      },
      data: {
        status: DayPassStatus.PENDING,
        priceCents: ctx.priceCents,
        currency: ctx.currency,
        stripePaymentIntentId: paymentIntent.id,
        ...(previousIntentId && previousIntentId !== paymentIntent.id
          ? { previousStripePaymentIntentIds: { push: previousIntentId } }
          : {}),
        attemptCount,
        lastAttemptAt: new Date(),
        lastStripeStatus: paymentIntent.status,
        lastPaymentErrorCode: null,
        lastPaymentDeclineCode: null,
        expiredAt: null,
      },
    });
    if (swapped.count === 0) {
      await this.throwSlotMovedConflict(slot.id, ctx, paymentIntent.id);
    }
    logDayPassEvent(this.logger, 'DAY_PASS_CHECKOUT_REPLACED', {
      ...this.eventFields(ctx, slot.id),
      stripePaymentIntentId: paymentIntent.id,
      previousStripePaymentIntentId: previousIntentId,
      attemptCount,
      reason,
      source: 'api',
    });
    logDayPassEvent(this.logger, 'DAY_PASS_RETRY', { ...this.eventFields(ctx, slot.id), attemptCount, reason });
    return this.buildSheetResponse(slot.id, paymentIntent, ctx);
  }

  /**
   * The idempotency key is derived from the slot, the attempt number and the price. Each attempt
   * number is owned by exactly one request (reserved by compare-and-swap before this call, or a
   * brand-new slot for attempt 1), so the key dedupes the Stripe SDK's own network retries of
   * THIS create and never replays another request's result. An intent created but left unbound by
   * a crash is harmless (its client_secret was never returned) and simply stays unused.
   */
  private createIntentForSlot(
    dayPassId: string,
    attempt: number,
    ctx: CheckoutContext,
  ): Promise<Stripe.PaymentIntent> {
    return this.stripe.createPaymentIntent(
      {
        amount: ctx.priceCents,
        currency: ctx.currency,
        customer: ctx.customerId,
        metadata: {
          type: 'day_pass',
          dayPassId,
          studioId: ctx.studioId,
          userId: ctx.userId,
          validForDate: ctx.validForDate,
          stripePriceId: ctx.stripePriceId,
          attempt: String(attempt),
        },
      },
      { idempotencyKey: `day_pass:${dayPassId}:a${attempt}:${ctx.priceCents}:${ctx.currency.toLowerCase()}` },
    );
  }

  private async buildSheetResponse(
    dayPassId: string,
    paymentIntent: Stripe.PaymentIntent,
    ctx: CheckoutContext,
  ): Promise<DayPassPaymentSheetResponse> {
    const clientSecret = paymentIntent.client_secret;
    if (!clientSecret) {
      throw new BadRequestException('Stripe PaymentIntent did not return a client secret');
    }
    const ephemeralKey = await this.stripe.createEphemeralKey(ctx.customerId, STRIPE_MOBILE_API_VERSION);
    const ephemeralKeySecret = ephemeralKey.secret;
    if (!ephemeralKeySecret) {
      throw new BadRequestException('Stripe EphemeralKey did not return a secret');
    }
    const publishableKey = this.config.getOrThrow<string>('STRIPE_PUBLISHABLE_KEY');
    return {
      dayPassId,
      paymentIntentClientSecret: clientSecret,
      customerId: ctx.customerId,
      ephemeralKeySecret,
      publishableKey,
    };
  }

  /**
   * Activates from a Stripe-retrieved succeeded intent and, when the paid intent superseded a
   * different unpaid one still bound to the slot, cancels that one so it cannot also be paid.
   */
  private async activateFromStripe(pi: Stripe.PaymentIntent): Promise<ActivationOutcome> {
    const outcome = await activateDayPassFromSucceededPaymentIntent(
      this.prisma,
      this.logger,
      snapshotFromStripePaymentIntent(pi),
      'api',
    );
    if (outcome.outcome === 'activated' && outcome.supersededIntentId) {
      await this.cancelIntentBestEffort(outcome.supersededIntentId, 'duplicate');
    }
    return outcome;
  }

  /**
   * The slot changed under us (paid, or bound by a concurrent request). Report its real state.
   * `mintedIntentId` is an intent THIS request created and failed to bind; it was never presented,
   * so it is cancelled — defensively only if the slot is not bound to it (never cancel an intent
   * the slot currently holds).
   */
  private async throwSlotMovedConflict(
    dayPassId: string,
    ctx: CheckoutContext,
    mintedIntentId: string | null,
  ): Promise<never> {
    const fresh = await this.prisma.dayPass.findUnique({
      where: { id: dayPassId },
      select: { status: true, stripePaymentIntentId: true },
    });
    if (mintedIntentId && fresh?.stripePaymentIntentId !== mintedIntentId) {
      await this.cancelIntentBestEffort(mintedIntentId, 'duplicate');
    }
    if (fresh?.status === DayPassStatus.ACTIVE) {
      this.logConflict(ctx, 'already_owned_raced', dayPassId);
      throw new ConflictException(MEMBER_ERRORS.dayPassAlreadyOwned);
    }
    this.logConflict(ctx, 'attempt_in_progress', dayPassId);
    throw new ConflictException(MEMBER_ERRORS.dayPassAttemptInProgress);
  }

  private async cancelIntentBestEffort(
    paymentIntentId: string,
    reason: 'abandoned' | 'duplicate',
  ): Promise<void> {
    try {
      await this.stripe.cancelPaymentIntent(paymentIntentId, reason);
    } catch (err) {
      // Already canceled / not cancelable; the replacement below still supersedes it locally
      // and a late success on it is honoured by the activation routine, never lost.
      this.logger.warn(
        `Day Pass: could not cancel stale PaymentIntent ${paymentIntentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Releases a slot that never received an intent. Guarded so it can never delete a paid row. */
  private async releaseIntentlessSlot(dayPassId: string): Promise<void> {
    try {
      await this.prisma.dayPass.deleteMany({
        where: { id: dayPassId, status: DayPassStatus.PENDING, stripePaymentIntentId: null },
      });
    } catch {
      // Best-effort. The original error is already propagating; do not mask it.
    }
  }

  private logConflict(ctx: CheckoutContext, reason: string, dayPassId: string | null): void {
    logDayPassEvent(this.logger, 'DAY_PASS_CONFLICT', { ...this.eventFields(ctx, dayPassId), reason, source: 'api' });
  }

  private eventFields(ctx: CheckoutContext, dayPassId: string | null) {
    return {
      studioId: ctx.studioId,
      userId: ctx.userId,
      dayPassId,
      validForDate: ctx.validForDate,
      priceCents: ctx.priceCents,
      currency: ctx.currency,
    };
  }
}

function toDto(row: {
  id: string;
  validForDate: Date;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  createdAt: Date;
}): DayPassResponseDto {
  return {
    id: row.id,
    validForDate: row.validForDate,
    status: row.status,
    priceCents: row.priceCents,
    currency: row.currency,
    createdAt: row.createdAt,
  };
}

function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { code?: unknown; statusCode?: unknown } | null;
  return !!e && (e.code === 'resource_missing' || e.statusCode === 404);
}
