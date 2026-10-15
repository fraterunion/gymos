/**
 * Smart Wallet 2.0 Stage 3 — refresh engine tuning. Deliberately constants, not environment
 * variables: there is one on/off switch (WALLET_REFRESH_WORKER_ENABLED) and nothing else to
 * misconfigure. Change here, with a test, if a cadence needs to move.
 */

/** How often the worker wakes up (each wake runs whichever phases are due). */
export const WALLET_REFRESH_TICK_MS = 5_000;
/** Change detection over committed entitlement data. */
export const WALLET_REFRESH_CHANGE_POLL_MS = 15_000;
/** Overlap re-scanned behind the cursor: absorbs commit delay and clock skew between instances. */
export const WALLET_REFRESH_CHANGE_OVERLAP_MS = 120_000;
/** Time-transition sweep (expiry, scheduled starts, day-pass midnights). */
export const WALLET_REFRESH_TRANSITION_SWEEP_MS = 60_000;
/** Transitions due within this window are enqueued ahead, with runAfter = the transition. */
export const WALLET_REFRESH_TRANSITION_LOOKAHEAD_MS = 5 * 60_000;
/** Pending-delivery sweep (only while APNs is enabled): re-queues passes whose newest version was not delivered. */
export const WALLET_REFRESH_UNDELIVERED_SWEEP_MS = 60_000;
/** Full reconciliation of every dynamic pass (safety net for anything a trigger missed). */
export const WALLET_REFRESH_RECONCILE_MS = 60 * 60_000;
/**
 * The first reconciliation after a worker starts runs after a random delay in this window, not at
 * boot: deploys and restarts of several instances do not all re-render every pass at once. (Change
 * detection resumes from its durable cursor and the transition and pending-delivery sweeps run at
 * the first tick, so nothing waits on this.)
 */
export const WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MIN_MS = 5 * 60_000;
export const WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS = 15 * 60_000;
/** Operational health evaluation (structured wallet.health.* log lines). */
export const WALLET_REFRESH_HEALTH_MS = 15 * 60_000;
/** Retention cleanup. */
export const WALLET_REFRESH_RETENTION_MS = 24 * 60 * 60_000;
/** Signing-certificate expiry check. */
export const WALLET_REFRESH_CERTIFICATE_CHECK_MS = 60 * 60_000;

/** Jobs claimed per tick and the lease each claim holds (jobs take seconds). */
export const WALLET_REFRESH_BATCH_SIZE = 10;
export const WALLET_REFRESH_LEASE_MS = 5 * 60_000;
export const WALLET_REFRESH_MAX_ATTEMPTS = 6;
/** Exponential backoff: 30 s, 60 s, 2 min, 4 min, 8 min … capped at 30 min, ±20 % jitter. */
export const WALLET_REFRESH_BACKOFF_BASE_MS = 30_000;
export const WALLET_REFRESH_BACKOFF_CAP_MS = 30 * 60_000;
/** After a dead letter, automatic triggers leave that member alone for this long. */
export const WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS = 6 * 60 * 60_000;
/** Members per enqueue statement (detection and reconciliation enqueue every candidate, in chunks). */
export const WALLET_REFRESH_ENQUEUE_CHUNK = 5_000;
/** Upper bound on members one transition sweep enqueues (most urgent first; the rest next sweep). */
export const WALLET_REFRESH_SWEEP_LIMIT = 5_000;

/** Retention (days). */
export const WALLET_PASS_EVENT_RETENTION_DAYS = 180;
export const WALLET_REFRESH_JOB_RETENTION_DAYS = 30;
export const WALLET_REFRESH_FAILED_JOB_RETENTION_DAYS = 90;
/** Rows deleted per retention statement (keeps locks short) and statements per table per run. */
export const WALLET_RETENTION_DELETE_BATCH = 1_000;
export const WALLET_RETENTION_MAX_BATCHES = 50;

/** Certificate expiry warning thresholds (days). */
export const WALLET_CERTIFICATE_WARN_DAYS = 30;
export const WALLET_CERTIFICATE_CRITICAL_DAYS = 7;

/** Diagnostics: an unregistration this soon after the same device registered is flagged as churn. */
export const WALLET_REGISTRATION_CHURN_WINDOW_MS = 10 * 60_000;

export const WALLET_REFRESH_CHANGE_CURSOR = 'entitlement_changes';

export type WalletRefreshReason = 'CHANGE_DETECTED' | 'TIME_TRANSITION' | 'UNDELIVERED' | 'RECONCILIATION' | 'MANUAL';

/** Health thresholds (Stage 4A). Findings use the billing-case severity vocabulary. */
export const WALLET_HEALTH_UNDELIVERED_AFTER_MS = 30 * 60_000;
export const WALLET_HEALTH_NOT_LISTED_AFTER_MS = 30 * 60_000;
export const WALLET_HEALTH_NEVER_REGISTERED_AFTER_MS = 24 * 60 * 60_000;
export const WALLET_HEALTH_QUEUE_BACKLOG_MEDIUM_MS = 10 * 60_000;
export const WALLET_HEALTH_QUEUE_BACKLOG_HIGH_MS = 60 * 60_000;
export const WALLET_HEALTH_APNS_REPEATED_FAILURES = 3;
export const WALLET_HEALTH_APNS_PLATFORM_FAILURES_PER_HOUR = 10;
export const WALLET_HEALTH_FAILURE_SPIKE_MIN = 5;
export const WALLET_HEALTH_FAILURE_SPIKE_FACTOR = 3;
export const WALLET_HEALTH_WORKER_IDLE_MS = 2 * 60 * 60_000;

/** Random first-reconciliation delay for a worker that just started. */
export function walletRefreshInitialReconcileDelayMs(random: () => number = Math.random): number {
  const span = WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS - WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MIN_MS;
  return WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MIN_MS + Math.round(span * random());
}

/**
 * Pure: is the last hour's refresh-failure count an unexpected increase over the previous day's
 * hourly average? Needs both an absolute floor and a multiple of the baseline, so a quiet system
 * does not alarm on two failures.
 */
export function isRefreshFailureSpike(lastHour: number, previous24h: number): boolean {
  const baselinePerHour = previous24h / 24;
  return lastHour >= WALLET_HEALTH_FAILURE_SPIKE_MIN && lastHour >= WALLET_HEALTH_FAILURE_SPIKE_FACTOR * Math.max(1, baselinePerHour);
}

/** Deterministic part of the retry delay for attempt n (n >= 1). */
export function walletRefreshBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(WALLET_REFRESH_BACKOFF_CAP_MS, WALLET_REFRESH_BACKOFF_BASE_MS * 2 ** exponent);
}

/** Backoff with ±20 % jitter so retries from many members do not align. */
export function walletRefreshBackoffWithJitterMs(attempt: number, random: () => number = Math.random): number {
  const base = walletRefreshBackoffMs(attempt);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export type CertificateExpiryLevel = 'OK' | 'WARN' | 'CRITICAL' | 'EXPIRED';

/** Pure: grades a signing certificate's remaining validity. */
export function certificateExpiryLevel(notAfter: Date, now: Date): { daysLeft: number; level: CertificateExpiryLevel } {
  const daysLeft = Math.floor((notAfter.getTime() - now.getTime()) / (24 * 60 * 60_000));
  const level: CertificateExpiryLevel =
    notAfter.getTime() <= now.getTime()
      ? 'EXPIRED'
      : daysLeft < WALLET_CERTIFICATE_CRITICAL_DAYS
        ? 'CRITICAL'
        : daysLeft < WALLET_CERTIFICATE_WARN_DAYS
          ? 'WARN'
          : 'OK';
  return { daysLeft, level };
}

