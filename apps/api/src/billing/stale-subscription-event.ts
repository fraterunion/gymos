import { SubscriptionStatus } from '@prisma/client';

/**
 * Out-of-order `customer.subscription.*` protection.
 *
 * Stripe never moves a subscription out of `canceled` / `incomplete_expired`: a new membership is
 * always a NEW subscription id. So when the local row for the SAME id is already CANCELED and an
 * event still describes it as alive, the event is either stale (created before the deletion but
 * delivered or finished after it — the 2026-09-28 class) or GymOS canceled the row itself while
 * Stripe kept billing. Neither case may be decided from event timestamps: two events can share a
 * second, and the handler that finishes last wins the row. The tie-breaker is Stripe's CURRENT
 * state, read live at conflict time.
 */
export const TERMINAL_STRIPE_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export function isTerminalStripeStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_STRIPE_STATUSES.has(status);
}

export type LiveSubscriptionLookup =
  | { ok: true; status: string; cancellationReason: string | null }
  | { ok: false; error: string };

export type TerminalConflictVerdict =
  /** No terminal conflict: the event may be applied through the normal upsert path. */
  | { action: 'APPLY' }
  /** Stripe confirms the subscription is over: the event is stale and must not touch the row. */
  | { action: 'IGNORE_STALE'; liveStatus: string }
  /**
   * Stripe says the subscription is alive while GymOS canceled it: a real discrepancy. The row is
   * left as GymOS decided and a reconciliation case is opened; nothing is auto-reactivated.
   */
  | { action: 'KEEP_LOCAL_OPEN_CASE'; liveStatus: string }
  /** Stripe could not be consulted: fail closed and let Stripe redeliver the event. */
  | { action: 'RETRY_UNVERIFIED'; error: string };

/** True when applying `incomingStripeStatus` to a row in `localStatus` needs a live Stripe check. */
export function needsLiveVerification(
  localStatus: SubscriptionStatus | null | undefined,
  incomingStripeStatus: string,
): boolean {
  return localStatus === SubscriptionStatus.CANCELED && !isTerminalStripeStatus(incomingStripeStatus);
}

export function judgeTerminalConflict(input: {
  localStatus: SubscriptionStatus | null | undefined;
  incomingStripeStatus: string;
  live: LiveSubscriptionLookup | null;
}): TerminalConflictVerdict {
  if (!needsLiveVerification(input.localStatus, input.incomingStripeStatus)) return { action: 'APPLY' };
  if (!input.live) return { action: 'RETRY_UNVERIFIED', error: 'live Stripe state was not fetched' };
  if (!input.live.ok) return { action: 'RETRY_UNVERIFIED', error: input.live.error };
  if (isTerminalStripeStatus(input.live.status)) return { action: 'IGNORE_STALE', liveStatus: input.live.status };
  return { action: 'KEEP_LOCAL_OPEN_CASE', liveStatus: input.live.status };
}

/** Thrown so the webhook stays unprocessed (visible, retried by Stripe) instead of guessing. */
export class StaleSubscriptionEventUnverifiedError extends Error {
  constructor(public readonly stripeSubscriptionId: string, cause: string) {
    super(`stale-event guard could not verify ${stripeSubscriptionId} against Stripe: ${cause}`);
    this.name = 'StaleSubscriptionEventUnverifiedError';
  }
}

/**
 * The row changed status between the locked read and the conditional write (a writer that does not
 * take the member lock). Retrying re-reads fresh state; nothing was overwritten.
 */
export class ConcurrentSubscriptionWriteError extends Error {
  constructor(public readonly stripeSubscriptionId: string, expectedStatus: string) {
    super(`subscription ${stripeSubscriptionId} changed concurrently (expected status ${expectedStatus}); event will be retried`);
    this.name = 'ConcurrentSubscriptionWriteError';
  }
}
