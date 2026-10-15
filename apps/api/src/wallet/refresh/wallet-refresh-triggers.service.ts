import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WALLET_PASS_EVENT_RETENTION_DAYS,
  WALLET_REFRESH_CHANGE_CURSOR,
  WALLET_REFRESH_CHANGE_OVERLAP_MS,
  WALLET_REFRESH_ENQUEUE_CHUNK,
  WALLET_REFRESH_FAILED_JOB_RETENTION_DAYS,
  WALLET_REFRESH_JOB_RETENTION_DAYS,
  WALLET_REFRESH_SWEEP_LIMIT,
  WALLET_REFRESH_TRANSITION_LOOKAHEAD_MS,
  WALLET_RETENTION_DELETE_BATCH,
  type WalletRefreshReason,
} from './wallet-refresh.constants';
import { WalletRefreshQueueService, type WalletRefreshTarget } from './wallet-refresh-queue.service';

const DAY_MS = 24 * 60 * 60_000;

/** Distinct advisory-lock keys per scheduling phase (pg_try_advisory_xact_lock). */
const LOCK_KEYS = {
  changes: 'wallet_refresh:detect_changes',
  transitions: 'wallet_refresh:transition_sweep',
  reconcile: 'wallet_refresh:reconcile',
} as const;

function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Members (studio, user) who hold at least one DYNAMIC Apple pass — the only refresh scope. */
const DYNAMIC_MEMBERS_CTE = Prisma.sql`
  dyn AS (
    SELECT DISTINCT wc.studio_id, wc.user_id
    FROM wallet_pass_artifacts a
    JOIN wallet_credentials wc ON wc.id = a.wallet_credential_id
    WHERE a.pass_mode = 'DYNAMIC'::"WalletPassMode" AND a.platform = 'APPLE'::"WalletPassPlatform"
  )`;

export type DetectionResult = { skipped: boolean; enqueued: number; candidates: number; since: Date | null; cursor: Date | null };

/**
 * What makes a dynamic pass go stale, and how each case is caught (Smart Wallet 2.0 Stage 3):
 *
 * 1. Data changes — detectChanges(): committed rows touched since the cursor (minus an overlap)
 *    for members who hold a dynamic pass: subscriptions (cash sales and renewals, Stripe renewals,
 *    payment failure and recovery, cancellations, plan switches, scheduled activations), day
 *    passes, wallet credentials (revocation / reissue), studio memberships, entitlement cycles,
 *    plan definitions, the member's profile and the studio. It reads only committed data, so it is
 *    post-commit by construction and needs no hook inside billing, sales or check-in code.
 * 2. Time — sweepTransitions(): passes whose stored nextTransitionAt is due (expiry, cycle
 *    boundaries, scheduled starts, day-pass midnights), enqueued to run exactly at the boundary.
 * 3. Anything else — reconcileAll(): every dynamic pass, periodically. A refresh whose content
 *    hash is unchanged writes nothing and pushes nothing, so this is cheap.
 *
 * The scan iterates the (small) set of dynamic-pass holders, using the existing
 * (studio_id, user_id) indexes on the source tables; no index is added to any existing table.
 */
@Injectable()
export class WalletRefreshTriggersService {
  private readonly logger = new Logger(WalletRefreshTriggersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: WalletRefreshQueueService,
  ) {}

  async detectChanges(now: Date): Promise<DetectionResult> {
    return this.withPhaseLock<DetectionResult>(LOCK_KEYS.changes, { skipped: true, enqueued: 0, candidates: 0, since: null, cursor: null }, async (tx) => {
      const cursor = await tx.walletRefreshCursor.findUnique({ where: { source: WALLET_REFRESH_CHANGE_CURSOR } });
      if (!cursor) {
        // First run: start from now. Existing state is covered by the first reconciliation.
        await tx.walletRefreshCursor.create({ data: { source: WALLET_REFRESH_CHANGE_CURSOR, position: now } });
        return { skipped: false, enqueued: 0, candidates: 0, since: null, cursor: now };
      }
      const since = new Date(cursor.position.getTime() - WALLET_REFRESH_CHANGE_OVERLAP_MS);
      const s = utc(since);
      const rows = await tx.$queryRaw<Array<{ studio_id: string; user_id: string }>>`
        WITH ${DYNAMIC_MEMBERS_CTE}
        SELECT d.studio_id, d.user_id FROM dyn d
        WHERE EXISTS (SELECT 1 FROM subscriptions x WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND x.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM day_passes x WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND x.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM wallet_credentials x WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND x.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM studio_memberships x WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND x.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM membership_entitlement_cycles x WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND x.created_at > ${s})
           OR EXISTS (SELECT 1 FROM subscriptions x JOIN membership_plans p ON p.id = x.membership_plan_id
                      WHERE x.studio_id = d.studio_id AND x.user_id = d.user_id AND p.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM users u WHERE u.id = d.user_id AND u.updated_at > ${s})
           OR EXISTS (SELECT 1 FROM studios st WHERE st.id = d.studio_id AND st.updated_at > ${s})`;
      // Bounded by the number of dynamic-pass holders; every candidate is enqueued before the
      // cursor moves (a crash in between only means the next run re-detects and coalesces).
      const targets = rows.map((r) => ({ studioId: r.studio_id, userId: r.user_id }));
      const enqueued = await this.enqueueInChunks(targets, 'CHANGE_DETECTED', now);
      await tx.walletRefreshCursor.update({ where: { source: WALLET_REFRESH_CHANGE_CURSOR }, data: { position: now } });
      if (targets.length > 0) {
        this.logger.log(JSON.stringify({ event: 'wallet.refresh.changes_detected', members: targets.length, enqueued }));
      }
      return { skipped: false, enqueued, candidates: targets.length, since, cursor: now };
    });
  }

  /** Enqueue members whose earliest dynamic-pass transition falls before now + lookahead. */
  async sweepTransitions(now: Date): Promise<{ skipped: boolean; enqueued: number }> {
    return this.withPhaseLock<{ skipped: boolean; enqueued: number }>(LOCK_KEYS.transitions, { skipped: true, enqueued: 0 }, async (tx) => {
      const horizon = new Date(now.getTime() + WALLET_REFRESH_TRANSITION_LOOKAHEAD_MS);
      const rows = await tx.$queryRaw<Array<{ studio_id: string; user_id: string; due: Date }>>`
        SELECT wc.studio_id, wc.user_id, MIN(a.next_transition_at) AS due
        FROM wallet_pass_artifacts a
        JOIN wallet_credentials wc ON wc.id = a.wallet_credential_id
        WHERE a.pass_mode = 'DYNAMIC'::"WalletPassMode" AND a.next_transition_at IS NOT NULL
          AND a.next_transition_at <= ${utc(horizon)}
        GROUP BY wc.studio_id, wc.user_id
        ORDER BY due ASC
        LIMIT ${WALLET_REFRESH_SWEEP_LIMIT}`;
      // Run just after the boundary: a refresh computed before it would still show the old state.
      const targets: WalletRefreshTarget[] = rows.map((r) => ({
        studioId: r.studio_id,
        userId: r.user_id,
        runAfter: new Date(new Date(r.due).getTime() + 1_000),
      }));
      const enqueued = await this.queue.enqueue(targets, 'TIME_TRANSITION', { now, respectCooldown: true });
      if (rows.length >= WALLET_REFRESH_SWEEP_LIMIT) {
        // Not lost: the remaining (later) transitions are picked up by the next sweep.
        this.logger.warn(JSON.stringify({ event: 'wallet.refresh.transition_sweep_capped', limit: WALLET_REFRESH_SWEEP_LIMIT }));
      }
      return { skipped: false, enqueued };
    });
  }

  /** Enqueue every dynamic-pass holder; unchanged passes cost a render and a hash comparison. */
  async reconcileAll(now: Date): Promise<{ skipped: boolean; enqueued: number; members: number }> {
    return this.withPhaseLock<{ skipped: boolean; enqueued: number; members: number }>(LOCK_KEYS.reconcile, { skipped: true, enqueued: 0, members: 0 }, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ studio_id: string; user_id: string }>>`
        WITH ${DYNAMIC_MEMBERS_CTE}
        SELECT studio_id, user_id FROM dyn ORDER BY studio_id, user_id`;
      const targets = rows.map((r) => ({ studioId: r.studio_id, userId: r.user_id }));
      const enqueued = await this.enqueueInChunks(targets, 'RECONCILIATION', now);
      this.logger.log(JSON.stringify({ event: 'wallet.refresh.reconciliation_enqueued', members: targets.length, enqueued }));
      return { skipped: false, enqueued, members: targets.length };
    });
  }

  /** Documented retention, in bounded batches (short locks). */
  async applyRetention(now: Date): Promise<{ events: number; jobs: number; failedJobs: number }> {
    const eventsBefore = new Date(now.getTime() - WALLET_PASS_EVENT_RETENTION_DAYS * DAY_MS);
    const jobsBefore = new Date(now.getTime() - WALLET_REFRESH_JOB_RETENTION_DAYS * DAY_MS);
    const failedBefore = new Date(now.getTime() - WALLET_REFRESH_FAILED_JOB_RETENTION_DAYS * DAY_MS);
    const events = await this.prisma.$executeRaw`
      DELETE FROM wallet_pass_events WHERE id IN (
        SELECT id FROM wallet_pass_events WHERE occurred_at < ${utc(eventsBefore)} LIMIT ${WALLET_RETENTION_DELETE_BATCH})`;
    const jobs = await this.prisma.$executeRaw`
      DELETE FROM wallet_pass_refresh_jobs WHERE id IN (
        SELECT id FROM wallet_pass_refresh_jobs
        WHERE status IN ('SUCCEEDED'::"WalletPassRefreshStatus", 'SUPERSEDED'::"WalletPassRefreshStatus")
          AND completed_at < ${utc(jobsBefore)} LIMIT ${WALLET_RETENTION_DELETE_BATCH})`;
    const failedJobs = await this.prisma.$executeRaw`
      DELETE FROM wallet_pass_refresh_jobs WHERE id IN (
        SELECT id FROM wallet_pass_refresh_jobs
        WHERE status = 'FAILED'::"WalletPassRefreshStatus" AND completed_at < ${utc(failedBefore)} LIMIT ${WALLET_RETENTION_DELETE_BATCH})`;
    if (events + jobs + failedJobs > 0) {
      this.logger.log(JSON.stringify({ event: 'wallet.refresh.retention_applied', events, jobs, failedJobs }));
    }
    return { events, jobs, failedJobs };
  }

  /** Automatic triggers respect the dead-letter cooldown; each statement stays bounded. */
  private async enqueueInChunks(targets: WalletRefreshTarget[], reason: WalletRefreshReason, now: Date): Promise<number> {
    let enqueued = 0;
    for (let i = 0; i < targets.length; i += WALLET_REFRESH_ENQUEUE_CHUNK) {
      enqueued += await this.queue.enqueue(targets.slice(i, i + WALLET_REFRESH_ENQUEUE_CHUNK), reason, { now, respectCooldown: true });
    }
    return enqueued;
  }

  /**
   * Runs a scheduling phase on at most one API instance at a time: a short DB-only transaction
   * holding a transaction-scoped advisory lock (released on commit; no session state).
   */
  private async withPhaseLock<T>(key: string, whenBusy: T, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS locked`;
      if (!locked) return whenBusy;
      return fn(tx);
    }, { timeout: 30_000 });
  }
}
