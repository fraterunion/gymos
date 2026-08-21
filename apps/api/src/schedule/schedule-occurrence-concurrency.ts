import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';

export function isScheduledOccurrenceUniqueViolation(error: unknown): boolean {
  if (!(error instanceof PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    const cols = target.map(String);
    return (
      cols.includes('studio_id') ||
      cols.includes('studioId') ||
      cols.includes('scheduled_classes_studio_template_starts_unique')
    );
  }
  return true;
}

/** Stable 64-bit advisory lock keys for pg_advisory_xact_lock(int, int). */
export function operationAdvisoryLockKeys(
  studioId: string,
  action: string,
  idempotencyKey: string,
): [number, number] {
  const digest = createHash('sha256')
    .update(`${studioId}|${action}|${idempotencyKey}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export async function acquireOperationAdvisoryLock(
  tx: Prisma.TransactionClient,
  studioId: string,
  action: string,
  idempotencyKey: string,
): Promise<void> {
  const [k1, k2] = operationAdvisoryLockKeys(studioId, action, idempotencyKey);
  await tx.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
    k1,
    k2,
  );
}

/** Lock a canonical occurrence slot for the duration of the current transaction. */
export async function acquireOccurrenceSlotLock(
  tx: Prisma.TransactionClient,
  studioId: string,
  classTemplateId: string,
  startsAt: Date,
): Promise<void> {
  const digest = createHash('sha256')
    .update(`occ|${studioId}|${classTemplateId}|${startsAt.toISOString()}`)
    .digest();
  await tx.$executeRawUnsafe(
    'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
    digest.readInt32BE(0),
    digest.readInt32BE(4),
  );
}
export type ScheduledOccurrenceInsert = {
  studioId: string;
  classTemplateId: string;
  instructorId: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  scheduleTemplateId?: string | null;
  exceptionKind?: null;
};
