import { Prisma } from '@prisma/client';

/**
 * MM-1/MM-4 — THE canonical member-scoped subscription-write lock. Every path that
 * creates, supersedes, or plan-changes a subscription row (cash sales, scheduled-cash
 * creation, Stripe webhooks, plan changes) serializes on this single key so no two paths
 * can concurrently pass a compatibility check and both write. Application-level first
 * line of defense; the partial unique indexes remain the final one.
 * Same pg_advisory_xact_lock pattern as membership-usage and wallet-credential locks, with
 * its own key namespace so it never contends with them. Each transaction takes at most
 * this one subscription lock (no nested subscription-lock acquisition), so no deadlock
 * cycle exists among subscription writers.
 */
export async function acquireSubscriptionWriteAdvisoryLock(
  tx: Prisma.TransactionClient,
  studioId: string,
  userId: string,
): Promise<void> {
  const lockKey = `subscription_write_${studioId}_${userId}`;
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock((hashtext(${lockKey}))::bigint)
  `);
}
