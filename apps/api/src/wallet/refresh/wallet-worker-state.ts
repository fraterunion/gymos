import {
  WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS,
  WALLET_HEALTH_WORKER_IDLE_MS,
  WALLET_HEALTH_WORKER_STARTING_MS,
  WALLET_HEALTH_WORKER_STARTUP_GRACE_MS,
  WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS,
} from './wallet-refresh.constants';

/**
 * - DISABLED: the worker flag is off.
 * - STARTING: a run began less than a minute ago.
 * - AWAITING_FIRST_RUN: alive, and no job has completed in this run yet, but the first
 *   reconciliation (deliberately 5–15 min after start) plus slack has not passed.
 * - HEALTHY: alive and completing jobs (or nothing to do: no dynamic passes).
 * - IDLE: alive but not completing work: the first run is overdue, or no job completed for 2 h.
 * - STOPPED: enabled, but the loop has not recorded a heartbeat recently (or ever).
 */
export type WalletRefreshWorkerState = 'DISABLED' | 'STARTING' | 'AWAITING_FIRST_RUN' | 'HEALTHY' | 'IDLE' | 'STOPPED';

export type WalletRefreshWorkerReason = 'NEVER_STARTED' | 'HEARTBEAT_STALE' | 'FIRST_RUN_OVERDUE' | 'NO_RECENT_COMPLETED_JOB';

export type WalletRefreshWorkerStatus = {
  state: WalletRefreshWorkerState;
  /** Why the worker is IDLE or STOPPED; null otherwise. */
  reason: WalletRefreshWorkerReason | null;
  runningSince: Date | null;
  lastHeartbeatAt: Date | null;
  lastCompletedAt: Date | null;
  /** While STARTING / AWAITING_FIRST_RUN (or once overdue): when a missing first run counts as idle. */
  firstRunDeadline: Date | null;
};

/**
 * Pure: classifies the refresh worker from durable facts only, so the in-process evaluation and
 * an external `wallet-diagnostics health` (e.g. a cron) agree. Never treats the deliberate
 * first-reconciliation delay as a failure, and never lets that grace hide a stopped loop (the
 * heartbeat is checked first) or a run that never completes anything (the grace is bounded).
 *
 * `expectsJobs` is whether reconciliation should produce jobs at all (dynamic passes in scope).
 */
export function classifyRefreshWorker(input: {
  now: Date;
  enabled: boolean;
  heartbeatAt: Date | null;
  runningSince: Date | null;
  lastCompletedAt: Date | null;
  expectsJobs: boolean;
}): WalletRefreshWorkerStatus {
  const { now, enabled, heartbeatAt, lastCompletedAt, expectsJobs } = input;
  const runningSince = input.runningSince ?? heartbeatAt;
  const status = (state: WalletRefreshWorkerState, reason: WalletRefreshWorkerReason | null = null, firstRunDeadline: Date | null = null): WalletRefreshWorkerStatus => ({
    state,
    reason,
    runningSince,
    lastHeartbeatAt: heartbeatAt,
    lastCompletedAt,
    firstRunDeadline,
  });

  if (!enabled) return status('DISABLED');
  if (!heartbeatAt || !runningSince) return status('STOPPED', 'NEVER_STARTED');
  if (now.getTime() - heartbeatAt.getTime() > WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS) return status('STOPPED', 'HEARTBEAT_STALE');

  const young = now.getTime() - runningSince.getTime() < WALLET_HEALTH_WORKER_STARTING_MS;
  if (!expectsJobs) return status(young ? 'STARTING' : 'HEALTHY');

  // Jobs completed before this run began say nothing about it (the worker may have been off).
  if (lastCompletedAt && lastCompletedAt.getTime() >= runningSince.getTime()) {
    return now.getTime() - lastCompletedAt.getTime() > WALLET_HEALTH_WORKER_IDLE_MS ? status('IDLE', 'NO_RECENT_COMPLETED_JOB') : status('HEALTHY');
  }
  const deadline = new Date(runningSince.getTime() + WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS + WALLET_HEALTH_WORKER_STARTUP_GRACE_MS);
  if (now.getTime() <= deadline.getTime()) return status(young ? 'STARTING' : 'AWAITING_FIRST_RUN', null, deadline);
  return status('IDLE', 'FIRST_RUN_OVERDUE', deadline);
}
