import { Prisma } from '@prisma/client';

/**
 * Serializes membership credit checks + attendance/booking writes for one member
 * within a studio (prevents concurrent walk-ins from exceeding plan limits).
 */
export async function acquireMembershipUsageAdvisoryLock(
  tx: Prisma.TransactionClient,
  studioId: string,
  userId: string,
): Promise<void> {
  const lockKey = `membership_usage_${studioId}_${userId}`;
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock((hashtext(${lockKey}))::bigint)
  `);
}
