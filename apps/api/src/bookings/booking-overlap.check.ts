import type { Prisma } from '@prisma/client';
import {
  findEffectiveOverlapBooking,
  memberBookingOverlapCandidateWhere,
} from './booking-overlap.utils';

export async function findMemberBookingTimeConflict(
  tx: Prisma.TransactionClient,
  input: {
    studioId: string;
    userId: string;
    targetScheduledClassId: string;
    targetClassTemplateId: string;
    targetStartsAt: Date;
    targetEndsAt: Date;
  },
): Promise<{ id: string } | undefined> {
  const overlapCandidates = await tx.booking.findMany({
    where: memberBookingOverlapCandidateWhere({
      studioId: input.studioId,
      userId: input.userId,
      targetScheduledClassId: input.targetScheduledClassId,
      targetStartsAt: input.targetStartsAt,
      targetEndsAt: input.targetEndsAt,
    }),
    select: {
      id: true,
      scheduledClass: {
        select: {
          startsAt: true,
          endsAt: true,
          classTemplate: { select: { durationMinutes: true } },
        },
      },
    },
  });

  const targetTemplate = await tx.classTemplate.findUniqueOrThrow({
    where: { id: input.targetClassTemplateId },
    select: { durationMinutes: true },
  });

  return findEffectiveOverlapBooking(overlapCandidates, {
    startsAt: input.targetStartsAt,
    endsAt: input.targetEndsAt,
    durationMinutes: targetTemplate.durationMinutes,
  });
}
