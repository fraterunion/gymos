import { Prisma } from '@prisma/client';

/**
 * Serializes booking create/cancel, waitlist join/cancel, and waitlist promotion
 * for a single scheduled class. Only raw SQL allowed for locking.
 */
export async function acquireBookingClassAdvisoryLock(
  tx: Prisma.TransactionClient,
  scheduledClassId: string,
): Promise<void> {
  const lockKey = `booking_class_${scheduledClassId}`;
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock((hashtext(${lockKey}))::bigint)
  `);
}
