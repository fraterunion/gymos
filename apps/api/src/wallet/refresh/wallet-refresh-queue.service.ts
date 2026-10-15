import { Injectable, Logger } from '@nestjs/common';
import { Prisma, WalletPassRefreshStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS,
  WALLET_REFRESH_LEASE_MS,
  WALLET_REFRESH_MAX_ATTEMPTS,
  walletRefreshBackoffWithJitterMs,
  type WalletRefreshReason,
} from './wallet-refresh.constants';

export type WalletRefreshTarget = { studioId: string; userId: string; runAfter?: Date };

export type ClaimedRefreshJob = {
  id: string;
  studioId: string;
  userId: string;
  attempts: number;
  maxAttempts: number;
  reason: string;
};

/** Bounded, secret-free error text for the job row and logs. */
export function sanitizeRefreshError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.replace(/[A-Za-z0-9_+/=-]{32,}/g, '[redacted]').slice(0, 300);
}

/** Timestamps are bound as ISO text and converted explicitly, so no session time zone matters. */
function utc(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === 'P2002';
  return error instanceof Error && /23505|unique constraint/i.test(error.message);
}

/**
 * Durable refresh queue (Smart Wallet 2.0 Stage 3), following the BuildJobs claim pattern.
 *
 * - enqueue: one statement; coalesces into the member's single PENDING row (partial unique
 *   index) keeping the EARLIEST runAfter, so a time-scheduled job is pulled forward by a change.
 * - claim: `FOR UPDATE SKIP LOCKED` + lease; safe with several API instances. A member with a
 *   live RUNNING job is skipped, so one member is never processed by two workers at once
 *   (except after a lease expires, where the optimistic artifact writes still hold).
 * - Every state change after a claim is guarded by (status RUNNING, lockedBy = this worker), so a
 *   worker whose lease was recovered can never overwrite the newer state.
 * - A retry that would collide with a newer PENDING row for the same member is SUPERSEDED: the
 *   pending row will recompute from scratch anyway.
 * - Nothing here calls out of the database, and every statement is short.
 */
@Injectable()
export class WalletRefreshQueueService {
  private readonly logger = new Logger(WalletRefreshQueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enqueue (or coalesce) refresh requests. Automatic triggers pass respectCooldown so a member
   * whose last job dead-lettered is not retried in a tight loop; operator requests do not.
   * Returns the number of rows inserted or coalesced.
   */
  async enqueue(
    targets: readonly WalletRefreshTarget[],
    reason: WalletRefreshReason,
    opts: { now?: Date; respectCooldown?: boolean } = {},
  ): Promise<number> {
    if (targets.length === 0) return 0;
    const now = opts.now ?? new Date();
    const studioIds = targets.map((t) => t.studioId);
    const userIds = targets.map((t) => t.userId);
    const runAfters = targets.map((t) => (t.runAfter && t.runAfter > now ? t.runAfter : now).toISOString());
    const cooldownSince = new Date(now.getTime() - WALLET_REFRESH_DEAD_LETTER_COOLDOWN_MS);
    const cooldownFilter = opts.respectCooldown
      ? Prisma.sql`WHERE NOT EXISTS (
          SELECT 1 FROM wallet_pass_refresh_jobs f
          WHERE f.studio_id = m.studio_id AND f.user_id = m.user_id
            AND f.status = 'FAILED'::"WalletPassRefreshStatus" AND f.completed_at > ${utc(cooldownSince)})`
      : Prisma.empty;

    return this.prisma.$executeRaw`
      INSERT INTO wallet_pass_refresh_jobs
        (id, studio_id, user_id, status, reason, run_after, max_attempts, created_at, updated_at)
      SELECT gen_random_uuid()::text, m.studio_id, m.user_id, 'PENDING'::"WalletPassRefreshStatus", ${reason},
             (m.run_after::timestamptz AT TIME ZONE 'UTC'), ${WALLET_REFRESH_MAX_ATTEMPTS}, now(), now()
      FROM unnest(${studioIds}::text[], ${userIds}::text[], ${runAfters}::text[]) AS m(studio_id, user_id, run_after)
      ${cooldownFilter}
      ON CONFLICT (studio_id, user_id) WHERE status = 'PENDING'::"WalletPassRefreshStatus"
      DO UPDATE SET run_after = LEAST(wallet_pass_refresh_jobs.run_after, EXCLUDED.run_after),
                    trigger_count = wallet_pass_refresh_jobs.trigger_count + 1,
                    updated_at = now()`;
  }

  async claim(workerId: string, now: Date, limit: number): Promise<ClaimedRefreshJob[]> {
    const leaseUntil = new Date(now.getTime() + WALLET_REFRESH_LEASE_MS);
    return this.prisma.$queryRaw<ClaimedRefreshJob[]>`
      WITH picked AS (
        SELECT p.id FROM wallet_pass_refresh_jobs p
        WHERE p.status = 'PENDING'::"WalletPassRefreshStatus" AND p.run_after <= ${utc(now)}
          -- one job per member at a time: wait while another worker holds a live lease on them
          AND NOT EXISTS (
            SELECT 1 FROM wallet_pass_refresh_jobs r
            WHERE r.studio_id = p.studio_id AND r.user_id = p.user_id
              AND r.status = 'RUNNING'::"WalletPassRefreshStatus" AND r.lease_expires_at > ${utc(now)})
        ORDER BY p.run_after ASC, p.created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE wallet_pass_refresh_jobs AS j
      SET status = 'RUNNING'::"WalletPassRefreshStatus",
          locked_by = ${workerId},
          lease_expires_at = ${utc(leaseUntil)},
          started_at = ${utc(now)},
          attempts = j.attempts + 1,
          updated_at = now()
      FROM picked
      WHERE j.id = picked.id
      RETURNING j.id, j.studio_id AS "studioId", j.user_id AS "userId", j.attempts, j.max_attempts AS "maxAttempts", j.reason`;
  }

  async complete(job: ClaimedRefreshJob, workerId: string, outcome: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.walletPassRefreshJob.updateMany({
      where: { id: job.id, status: WalletPassRefreshStatus.RUNNING, lockedBy: workerId },
      data: {
        status: WalletPassRefreshStatus.SUCCEEDED,
        outcome: outcome.slice(0, 300),
        completedAt: now,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
    return count === 1;
  }

  /** Retryable failure: back to PENDING with backoff, or a dead letter once attempts run out. */
  async retryOrFail(
    job: ClaimedRefreshJob,
    workerId: string,
    error: unknown,
    now: Date,
    random: () => number = Math.random,
  ): Promise<'RETRY' | 'FAILED' | 'SUPERSEDED' | 'LOST'> {
    const lastError = sanitizeRefreshError(error);
    if (job.attempts >= job.maxAttempts) {
      return (await this.fail(job, workerId, lastError, now)) ? 'FAILED' : 'LOST';
    }
    const runAfter = new Date(now.getTime() + walletRefreshBackoffWithJitterMs(job.attempts, random));
    try {
      const { count } = await this.prisma.walletPassRefreshJob.updateMany({
        where: { id: job.id, status: WalletPassRefreshStatus.RUNNING, lockedBy: workerId },
        data: { status: WalletPassRefreshStatus.PENDING, runAfter, lastError, lockedBy: null, leaseExpiresAt: null },
      });
      return count === 1 ? 'RETRY' : 'LOST';
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return (await this.supersede(job.id, { lockedBy: workerId }, lastError, now)) ? 'SUPERSEDED' : 'LOST';
    }
  }

  /** Non-retryable failure (integrity / poison): dead letter. */
  async fail(job: ClaimedRefreshJob, workerId: string, error: unknown, now: Date): Promise<boolean> {
    const lastError = typeof error === 'string' ? error.slice(0, 300) : sanitizeRefreshError(error);
    const { count } = await this.prisma.walletPassRefreshJob.updateMany({
      where: { id: job.id, status: WalletPassRefreshStatus.RUNNING, lockedBy: workerId },
      data: { status: WalletPassRefreshStatus.FAILED, lastError, completedAt: now, lockedBy: null, leaseExpiresAt: null },
    });
    if (count === 1) {
      this.logger.error(
        JSON.stringify({
          event: 'wallet.refresh.dead_letter',
          jobId: job.id,
          studioId: job.studioId,
          attempts: job.attempts,
          error: lastError,
        }),
      );
    }
    return count === 1;
  }

  /**
   * Crash recovery: RUNNING jobs whose lease expired go back to PENDING (or dead-letter once
   * their attempts are spent, so a job that kills its worker cannot loop forever).
   */
  async recoverExpiredLeases(now: Date, limit = 100): Promise<{ requeued: number; superseded: number; failed: number }> {
    const expired = await this.prisma.walletPassRefreshJob.findMany({
      where: { status: WalletPassRefreshStatus.RUNNING, leaseExpiresAt: { lt: now } },
      select: { id: true, studioId: true, userId: true, attempts: true, maxAttempts: true, lockedBy: true, leaseExpiresAt: true },
      orderBy: { leaseExpiresAt: 'asc' },
      take: limit,
    });
    const result = { requeued: 0, superseded: 0, failed: 0 };
    for (const job of expired) {
      const guard = { id: job.id, status: WalletPassRefreshStatus.RUNNING, leaseExpiresAt: job.leaseExpiresAt };
      if (job.attempts >= job.maxAttempts) {
        const { count } = await this.prisma.walletPassRefreshJob.updateMany({
          where: guard,
          data: { status: WalletPassRefreshStatus.FAILED, lastError: 'LEASE_EXPIRED_AFTER_MAX_ATTEMPTS', completedAt: now, lockedBy: null, leaseExpiresAt: null },
        });
        result.failed += count;
        if (count) this.logger.error(JSON.stringify({ event: 'wallet.refresh.dead_letter', jobId: job.id, studioId: job.studioId, attempts: job.attempts, error: 'LEASE_EXPIRED_AFTER_MAX_ATTEMPTS' }));
        continue;
      }
      try {
        const { count } = await this.prisma.walletPassRefreshJob.updateMany({
          where: guard,
          data: { status: WalletPassRefreshStatus.PENDING, runAfter: now, lastError: 'LEASE_EXPIRED', lockedBy: null, leaseExpiresAt: null },
        });
        result.requeued += count;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        result.superseded += (await this.supersede(job.id, { leaseExpiresAt: job.leaseExpiresAt }, 'LEASE_EXPIRED', now)) ? 1 : 0;
      }
    }
    if (expired.length > 0) {
      this.logger.warn(JSON.stringify({ event: 'wallet.refresh.leases_recovered', ...result }));
    }
    return result;
  }

  async stats(now: Date): Promise<{
    byStatus: Record<string, number>;
    oldestPendingRunAfter: Date | null;
    oldestPendingAgeMs: number | null;
    failedLast24h: Array<{ lastError: string | null; count: number }>;
  }> {
    const grouped = await this.prisma.walletPassRefreshJob.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const oldest = await this.prisma.walletPassRefreshJob.findFirst({
      where: { status: WalletPassRefreshStatus.PENDING, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { runAfter: true },
    });
    const failed = await this.prisma.walletPassRefreshJob.groupBy({
      by: ['lastError'],
      where: { status: WalletPassRefreshStatus.FAILED, completedAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
      _count: { _all: true },
    });
    return {
      byStatus,
      oldestPendingRunAfter: oldest?.runAfter ?? null,
      oldestPendingAgeMs: oldest ? now.getTime() - oldest.runAfter.getTime() : null,
      failedLast24h: failed.map((f) => ({ lastError: f.lastError, count: f._count._all })),
    };
  }

  private async supersede(
    id: string,
    extraGuard: Prisma.WalletPassRefreshJobWhereInput,
    lastError: string,
    now: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.walletPassRefreshJob.updateMany({
      where: { id, status: WalletPassRefreshStatus.RUNNING, ...extraGuard },
      data: {
        status: WalletPassRefreshStatus.SUPERSEDED,
        outcome: 'superseded_by_pending',
        lastError,
        completedAt: now,
        lockedBy: null,
        leaseExpiresAt: null,
      },
    });
    return count === 1;
  }
}
