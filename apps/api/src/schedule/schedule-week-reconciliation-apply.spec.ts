import {
  boundedAuditClassIds,
  WEEK_RECONCILIATION_AUDIT_ID_CAP,
} from './schedule-week-reconciliation-apply';

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
