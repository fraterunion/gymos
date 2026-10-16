import {
  WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS,
  WALLET_HEALTH_WORKER_IDLE_MS,
  WALLET_HEALTH_WORKER_STARTUP_GRACE_MS,
  WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS,
} from './wallet-refresh.constants';
import { classifyRefreshWorker } from './wallet-worker-state';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const FIRST_RUN_DEADLINE_MS = WALLET_REFRESH_RECONCILE_INITIAL_DELAY_MAX_MS + WALLET_HEALTH_WORKER_STARTUP_GRACE_MS;

/** A live worker (heartbeat 10 s ago) with dynamic passes to reconcile, unless overridden. */
const classify = (over: Partial<Parameters<typeof classifyRefreshWorker>[0]> = {}) =>
  classifyRefreshWorker({ now: NOW, enabled: true, heartbeatAt: ago(10_000), runningSince: ago(30 * MIN), lastCompletedAt: ago(20 * MIN), expectsJobs: true, ...over });

describe('refresh worker liveness classification (Stage 4A.1)', () => {
  it('worker disabled: DISABLED, whatever the history says', () => {
    expect(classify({ enabled: false, heartbeatAt: null, runningSince: null, lastCompletedAt: ago(10 * HOUR) })).toMatchObject({ state: 'DISABLED', reason: null });
    expect(classify({ enabled: false, heartbeatAt: ago(10 * HOUR) }).state).toBe('DISABLED');
  });

  it('the Stage 4A staging case: first evaluation after a long disabled period is STARTING, not idle', () => {
    // Staging 2026-10-16 01:38:49Z: last completed job 356 min earlier, worker started 5 s before.
    const s = classify({ runningSince: ago(5_000), heartbeatAt: ago(5_000), lastCompletedAt: ago(356 * MIN) });
    expect(s).toMatchObject({ state: 'STARTING', reason: null });
    expect(s.firstRunDeadline).toEqual(new Date(ago(5_000).getTime() + FIRST_RUN_DEADLINE_MS));
  });

  it('awaiting the delayed first reconciliation (5–15 min) plus slack: AWAITING_FIRST_RUN, never IDLE', () => {
    for (const sinceStart of [2 * MIN, 5 * MIN, 15 * MIN, FIRST_RUN_DEADLINE_MS]) {
      expect(classify({ runningSince: ago(sinceStart), lastCompletedAt: ago(6 * HOUR) })).toMatchObject({ state: 'AWAITING_FIRST_RUN', reason: null });
    }
    expect(classify({ runningSince: ago(10 * MIN), lastCompletedAt: null })).toMatchObject({ state: 'AWAITING_FIRST_RUN' });
  });

  it('the first reconciliation completing makes it HEALTHY', () => {
    expect(classify({ runningSince: ago(12 * MIN), lastCompletedAt: ago(1 * MIN) })).toMatchObject({ state: 'HEALTHY', reason: null });
  });

  it('a first run that never completes is reported once the bounded grace ends (a genuine stall is not hidden)', () => {
    const s = classify({ runningSince: ago(FIRST_RUN_DEADLINE_MS + 1_000), lastCompletedAt: ago(6 * HOUR) });
    expect(s).toMatchObject({ state: 'IDLE', reason: 'FIRST_RUN_OVERDUE' });
    expect(classify({ runningSince: ago(FIRST_RUN_DEADLINE_MS + 1_000), lastCompletedAt: null })).toMatchObject({ state: 'IDLE', reason: 'FIRST_RUN_OVERDUE' });
  });

  it('a running worker that stops completing jobs for over 2 h is IDLE', () => {
    expect(classify({ runningSince: ago(5 * HOUR), lastCompletedAt: ago(WALLET_HEALTH_WORKER_IDLE_MS + MIN) })).toMatchObject({ state: 'IDLE', reason: 'NO_RECENT_COMPLETED_JOB' });
    expect(classify({ runningSince: ago(5 * HOUR), lastCompletedAt: ago(WALLET_HEALTH_WORKER_IDLE_MS - MIN) }).state).toBe('HEALTHY');
  });

  it('a stopped loop is STOPPED even inside the startup grace (the grace never hides a dead worker)', () => {
    const stale = ago(WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS + 1_000);
    expect(classify({ runningSince: ago(6 * MIN), heartbeatAt: stale, lastCompletedAt: null })).toMatchObject({ state: 'STOPPED', reason: 'HEARTBEAT_STALE' });
    expect(classify({ heartbeatAt: stale })).toMatchObject({ state: 'STOPPED', reason: 'HEARTBEAT_STALE' });
    expect(classify({ heartbeatAt: ago(WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS - 1_000) }).state).toBe('HEALTHY');
  });

  it('enabled but never started (no heartbeat ever): STOPPED / NEVER_STARTED', () => {
    expect(classify({ heartbeatAt: null, runningSince: null, lastCompletedAt: ago(10 * HOUR) })).toMatchObject({ state: 'STOPPED', reason: 'NEVER_STARTED' });
  });

  it('a quick restart keeps the earlier run (the caller keeps runningSince), so a restart loop cannot renew the grace', () => {
    // Worker running for 3 h, restarted 2 min ago; its last completed job was 70 min ago (hourly reconciliation).
    expect(classify({ runningSince: ago(3 * HOUR), heartbeatAt: ago(5_000), lastCompletedAt: ago(70 * MIN) }).state).toBe('HEALTHY');
    // Crash-looping for 3 h without ever completing anything: idle, not "starting".
    expect(classify({ runningSince: ago(3 * HOUR), heartbeatAt: ago(5_000), lastCompletedAt: null })).toMatchObject({ state: 'IDLE', reason: 'FIRST_RUN_OVERDUE' });
  });

  it('no dynamic passes: nothing to complete, so never IDLE; liveness still checked', () => {
    expect(classify({ expectsJobs: false, lastCompletedAt: null, runningSince: ago(5 * HOUR) }).state).toBe('HEALTHY');
    expect(classify({ expectsJobs: false, runningSince: ago(10_000) }).state).toBe('STARTING');
    expect(classify({ expectsJobs: false, heartbeatAt: ago(WALLET_HEALTH_WORKER_HEARTBEAT_STALE_MS + 1_000) }).state).toBe('STOPPED');
  });

  it('jobs completed before this run began do not count for it', () => {
    // Re-enabled 3 min ago after a gap; a job completed 10 min ago belongs to the previous run.
    expect(classify({ runningSince: ago(3 * MIN), lastCompletedAt: ago(10 * MIN) }).state).toBe('AWAITING_FIRST_RUN');
  });
});
