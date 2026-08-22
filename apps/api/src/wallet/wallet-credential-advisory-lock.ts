import { Prisma } from '@prisma/client';

/**
 * Serializes issue/reissue for one member within a studio so concurrent requests cannot
 * both pass the "no active credential exists" check before either commits. The partial
 * unique index on wallet_credentials(studio_id, user_id) WHERE revoked_at IS NULL is the
 * authoritative backstop; this lock exists so a racing caller gets back the winning
 * credential instead of a raw constraint-violation error.
 */
export async function acquireWalletCredentialAdvisoryLock(
  tx: Prisma.TransactionClient,
  studioId: string,
  userId: string,
): Promise<void> {
  const lockKey = `wallet_credential_${studioId}_${userId}`;
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock((hashtext(${lockKey}))::bigint)
  `);
}
