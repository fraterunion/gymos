import { Prisma } from '@prisma/client';

/**
 * MM-1 — serializes subscription creation/compatibility checks for one member within a
 * studio (cash sale racing Stripe checkout, double-clicked purchases, replayed webhooks).
 * Application-level first line of defense; the partial unique indexes remain the final one.
 * Same pg_advisory_xact_lock pattern as membership-usage and wallet-credential locks, with
 * its own key namespace so it never contends with them.
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
