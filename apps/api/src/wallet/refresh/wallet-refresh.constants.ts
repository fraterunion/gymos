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
/** Full reconciliation of every dynamic pass (safety net for anything a trigger missed). */
export const WALLET_REFRESH_RECONCILE_MS = 60 * 60_000;
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
/** Rows deleted per retention statement (keeps locks short). */
export const WALLET_RETENTION_DELETE_BATCH = 1_000;

/** Certificate expiry warning thresholds (days). */
export const WALLET_CERTIFICATE_WARN_DAYS = 30;
export const WALLET_CERTIFICATE_CRITICAL_DAYS = 7;

/** Diagnostics: an unregistration this soon after the same device registered is flagged as churn. */
export const WALLET_REGISTRATION_CHURN_WINDOW_MS = 10 * 60_000;

export const WALLET_REFRESH_CHANGE_CURSOR = 'entitlement_changes';

export type WalletRefreshReason = 'CHANGE_DETECTED' | 'TIME_TRANSITION' | 'RECONCILIATION' | 'MANUAL';

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

