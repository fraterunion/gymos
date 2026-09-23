import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DayPassStatus } from '@prisma/client';
import { CronJob } from 'cron';
import type Stripe from 'stripe';
import { getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../common/date/studio-local-date';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import {
  activateDayPassFromSucceededPaymentIntent,
  snapshotFromStripePaymentIntent,
} from './day-pass-activation';
import { logDayPassEvent } from './day-pass-events';

/** Hourly at :20 — a studio's day lapses at its own local midnight, so hourly keeps every timezone within an hour. */
const SWEEP_CRON = '20 * * * *';
const SWEEP_JOB_NAME = 'day-pass-attempt-sweep-hourly';

/**
 * Master switch for the hourly sweep. OFF by default: deploying this code changes no existing
 * row. Correctness never depends on the sweep (past dates are rejected by the API and a paid
 * attempt is activated by the webhook, the retry path or /sync); it only makes lapsed
 * attempts explicit as EXPIRED and self-heals a paid attempt whose webhook was lost.
 */
export const DAY_PASS_SWEEP_ENABLED_ENV = 'DAY_PASS_SWEEP_ENABLED';

/**
 * Opt-in: also cancel the lapsed attempts' PaymentIntents at Stripe (`cancellation_reason:
 * abandoned`) so they stop appearing as "Incomplete" in the Dashboard and can never be paid
 * for a day that is over. Off by default because it is a live-account mutation; bookkeeping
 * (EXPIRED) happens either way.
 */
export const DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS_ENV = 'DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS';

export type SweepResult = {
  /** Attempts moved PENDING → EXPIRED. */
  expired: number;
  /** Attempts found paid at Stripe (webhook never landed) and activated instead. */
  activated: number;
  /** Attempts left untouched: intent still processing, or Stripe unreachable (retried next run). */
  deferred: number;
};

/**
 * Closes checkout attempts whose calendar day has already passed (studio timezone).
 *
 * Never trusts the local row: each candidate's PaymentIntent is retrieved from Stripe first.
 *   succeeded              → activate through the shared routine (money moved; entitlement follows)
 *   processing             → defer (money may still move)
 *   requires_* / canceled  → EXPIRED (+ optional Stripe cancel)
 *   unreachable            → defer, retry next run
 * ACTIVE rows are never selected; nothing is deleted; every write is a filtered UPDATE
 * conditioned on the row still being PENDING with the same intent, so concurrent instances,
 * webhooks and member retries cannot interleave into a wrong state.
 */
@Injectable()
export class DayPassAttemptSweepService implements OnModuleInit {
  private readonly logger = new Logger(DayPassAttemptSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (process.env['GYMOS_E2E'] === '1' || !this.schedulerRegistry) {
      return;
    }
    if (this.config.get<string>(DAY_PASS_SWEEP_ENABLED_ENV, '0') !== '1') {
      this.logger.log(`Day Pass attempt sweep disabled (${DAY_PASS_SWEEP_ENABLED_ENV}!=1); no cron registered`);
      return;
    }
    const job = new CronJob(SWEEP_CRON, () => {
      void this.expireLapsedAttempts().catch((err) => {
        this.logger.error('Day Pass attempt sweep failed', err instanceof Error ? err.stack : String(err));
      });
    });
    this.schedulerRegistry.addCronJob(SWEEP_JOB_NAME, job);
    job.start();
  }

  private cancelAtStripeEnabled(): boolean {
    return this.config.get<string>(DAY_PASS_SWEEP_CANCEL_STRIPE_INTENTS_ENV, '0') === '1';
  }

  /** `now` is injectable for tests. */
  async expireLapsedAttempts(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { expired: 0, activated: 0, deferred: 0 };
    const studiosWithAttempts = await this.prisma.dayPass.groupBy({
      by: ['studioId'],
      where: { status: DayPassStatus.PENDING },
    });
    if (studiosWithAttempts.length === 0) return result;

    const studios = await this.prisma.studio.findMany({
      where: { id: { in: studiosWithAttempts.map((s) => s.studioId) } },
      select: { id: true, timezone: true },
    });

    for (const studio of studios) {
      const todayKey = getStudioLocalDateKey(now, studio.timezone);
      const todayAnchor = studioLocalDateKeyToUtcAnchor(todayKey, studio.timezone);
      const candidates = await this.prisma.dayPass.findMany({
        where: { studioId: studio.id, status: DayPassStatus.PENDING, validForDate: { lt: todayAnchor } },
        select: { id: true, userId: true, validForDate: true, stripePaymentIntentId: true },
        orderBy: { validForDate: 'asc' },
      });
      for (const c of candidates) {
        const base = {
          studioId: studio.id,
          userId: c.userId,
          dayPassId: c.id,
          validForDate: c.validForDate.toISOString().slice(0, 10),
          stripePaymentIntentId: c.stripePaymentIntentId,
          source: 'sweep' as const,
        };

        if (!c.stripePaymentIntentId) {
          const r = await this.prisma.dayPass.updateMany({
            where: { id: c.id, status: DayPassStatus.PENDING, stripePaymentIntentId: null },
            data: { status: DayPassStatus.EXPIRED, expiredAt: now },
          });
          if (r.count) {
            result.expired += r.count;
            logDayPassEvent(this.logger, 'DAY_PASS_ATTEMPT_EXPIRED', { ...base, reason: 'no_intent' });
          }
          continue;
        }

        let pi: Stripe.PaymentIntent | null = null;
        let missing = false;
        try {
          pi = await this.stripe.retrievePaymentIntent(c.stripePaymentIntentId);
        } catch (err) {
          const e = err as { code?: unknown; statusCode?: unknown };
          if (e?.code === 'resource_missing' || e?.statusCode === 404) {
            missing = true;
          } else {
            result.deferred += 1;
            logDayPassEvent(this.logger, 'DAY_PASS_ATTEMPT_EXPIRED', { ...base, reason: 'stripe_unreachable_deferred' }, 'warn');
            continue;
          }
        }

        if (pi?.status === 'succeeded') {
          const outcome = await activateDayPassFromSucceededPaymentIntent(
            this.prisma,
            this.logger,
            snapshotFromStripePaymentIntent(pi),
            'reconciliation',
          );
          if (outcome.outcome === 'activated') {
            result.activated += 1;
            logDayPassEvent(this.logger, 'DAY_PASS_RECONCILED', { ...base, reason: 'paid_but_never_activated' }, 'warn');
          } else if (outcome.outcome === 'ignored') {
            // e.g. refunded at Stripe: never expired (money moved) and never activated; an
            // operator decides. Reported every run until resolved.
            result.deferred += 1;
            logDayPassEvent(this.logger, 'DAY_PASS_RECONCILED', { ...base, reason: `paid_intent_needs_review:${outcome.reason}` }, 'warn');
          }
          continue;
        }
        if (pi?.status === 'processing' || pi?.status === 'requires_capture') {
          result.deferred += 1;
          continue;
        }

        const stripeStatus = missing ? 'missing' : pi!.status;
        if (!missing && stripeStatus !== 'canceled' && this.cancelAtStripeEnabled()) {
          try {
            await this.stripe.cancelPaymentIntent(c.stripePaymentIntentId, 'abandoned');
          } catch (err) {
            this.logger.warn(
              `Day Pass sweep: could not cancel PaymentIntent ${c.stripePaymentIntentId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        const r = await this.prisma.dayPass.updateMany({
          where: { id: c.id, status: DayPassStatus.PENDING, stripePaymentIntentId: c.stripePaymentIntentId },
          data: { status: DayPassStatus.EXPIRED, expiredAt: now, lastStripeStatus: stripeStatus },
        });
        if (r.count) {
          result.expired += r.count;
          logDayPassEvent(this.logger, 'DAY_PASS_ATTEMPT_EXPIRED', { ...base, stripeStatus, beforeLocalDate: todayKey });
        }
      }
    }
    return result;
  }
}
