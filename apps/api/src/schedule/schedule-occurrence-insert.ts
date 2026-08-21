import type { Prisma } from '@prisma/client';
import { ClassStatus } from '@prisma/client';
import {
  acquireOccurrenceSlotLock,
  isScheduledOccurrenceUniqueViolation,
  type ScheduledOccurrenceInsert,
} from './schedule-occurrence-concurrency';

export type OccurrenceInsertOutcome =
  | { outcome: 'created'; id: string }
  | { outcome: 'skipped_already_exists' };

export async function insertScheduledOccurrenceOrSkip(
  tx: Prisma.TransactionClient,
  data: ScheduledOccurrenceInsert,
): Promise<OccurrenceInsertOutcome> {
  await acquireOccurrenceSlotLock(
    tx,
    data.studioId,
    data.classTemplateId,
    data.startsAt,
  );

  const existing = await tx.scheduledClass.findFirst({
    where: {
      studioId: data.studioId,
      classTemplateId: data.classTemplateId,
      startsAt: data.startsAt,
    },
    select: { id: true },
  });
  if (existing) {
    return { outcome: 'skipped_already_exists' };
  }

  try {
    const row = await tx.scheduledClass.create({
      data: {
        studioId: data.studioId,
        classTemplateId: data.classTemplateId,
        instructorId: data.instructorId,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        capacity: data.capacity,
        status: ClassStatus.SCHEDULED,
        scheduleTemplateId: data.scheduleTemplateId ?? null,
        exceptionKind: data.exceptionKind ?? null,
      },
      select: { id: true },
    });
    return { outcome: 'created', id: row.id };
  } catch (error) {
    if (isScheduledOccurrenceUniqueViolation(error)) {
      return { outcome: 'skipped_already_exists' };
    }
    throw error;
  }
}
