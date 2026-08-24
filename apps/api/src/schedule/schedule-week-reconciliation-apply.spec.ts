import {
  boundedAuditClassIds,
  applyWeekReconciliationPlanBatched,
  WEEK_RECONCILIATION_AUDIT_ID_CAP,
} from './schedule-week-reconciliation-apply';
import { ClassStatus } from '@prisma/client';

describe('boundedAuditClassIds', () => {
  it('returns all ids when under cap', () => {
    const ids = ['a', 'b', 'c'];
    expect(boundedAuditClassIds(ids)).toEqual({
      affectedClassIds: ids,
      affectedClassIdsTruncated: false,
      affectedClassCount: 3,
    });
  });

  it('truncates ids at audit cap', () => {
    const ids = Array.from({ length: WEEK_RECONCILIATION_AUDIT_ID_CAP + 50 }, (_, i) =>
      String(i),
    );
    const bounded = boundedAuditClassIds(ids);
    expect(bounded.affectedClassIds).toHaveLength(WEEK_RECONCILIATION_AUDIT_ID_CAP);
    expect(bounded.affectedClassIdsTruncated).toBe(true);
    expect(bounded.affectedClassCount).toBe(WEEK_RECONCILIATION_AUDIT_ID_CAP + 50);
  });
});

describe('applyWeekReconciliationPlanBatched removal modes', () => {
  it('hard-deletes when removalMode is HARD_DELETE', async () => {
    const deleted: string[][] = [];
    const tx = {
      scheduledClass: {
        createManyAndReturn: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(),
        deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
          deleted.push(where.id.in);
          return { count: where.id.in.length };
        }),
      },
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      waitlistEntry: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const result = await applyWeekReconciliationPlanBatched(tx as never, 'studio-1', {
      actions: [{ kind: 'REMOVE', existingId: 'extra-1', removalMode: 'HARD_DELETE' }],
      reusedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      removedCount: 1,
      reviewCount: 0,
      blockedCount: 0,
      affectedReservationCount: 0,
    });

    expect(tx.scheduledClass.deleteMany).toHaveBeenCalled();
    expect(tx.scheduledClass.updateMany).not.toHaveBeenCalled();
    expect(result.hardDeletedCount).toBe(1);
    expect(result.softCancelledCount).toBe(0);
    expect(deleted[0]).toEqual(['extra-1']);
  });

  it('soft-cancels when removalMode is omitted (legacy apply callers)', async () => {
    const tx = {
      scheduledClass: {
        createManyAndReturn: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      waitlistEntry: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    const result = await applyWeekReconciliationPlanBatched(tx as never, 'studio-1', {
      actions: [{ kind: 'REMOVE', existingId: 'extra-1' }],
      reusedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      removedCount: 1,
      reviewCount: 0,
      blockedCount: 0,
      affectedReservationCount: 0,
    });

    expect(tx.scheduledClass.deleteMany).not.toHaveBeenCalled();
    expect(tx.scheduledClass.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ClassStatus.CANCELLED }),
      }),
    );
    expect(result.softCancelledCount).toBe(1);
    expect(result.hardDeletedCount).toBe(0);
  });
});
