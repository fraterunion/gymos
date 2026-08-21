import {
  sortedUniqueTargetWeekStarts,
  weekReconciliationAdvisoryLockKeys,
} from './schedule-occurrence-concurrency';

describe('week reconciliation advisory locks', () => {
  it('sorts target weeks deterministically', () => {
    expect(
      sortedUniqueTargetWeekStarts(['2026-09-14', '2026-09-07', '2026-09-14']),
    ).toEqual(['2026-09-07', '2026-09-14']);
  });

  it('uses stable lock keys for the same studio and week', () => {
    const a = weekReconciliationAdvisoryLockKeys('studio-1', '2026-09-07');
    const b = weekReconciliationAdvisoryLockKeys('studio-1', '2026-09-07');
    expect(a).toEqual(b);
  });

  it('uses different lock keys for different weeks in the same studio', () => {
    const a = weekReconciliationAdvisoryLockKeys('studio-1', '2026-09-07');
    const b = weekReconciliationAdvisoryLockKeys('studio-1', '2026-09-14');
    expect(a).not.toEqual(b);
  });

  it('uses different lock keys for different studios on the same week', () => {
    const a = weekReconciliationAdvisoryLockKeys('studio-a', '2026-09-07');
    const b = weekReconciliationAdvisoryLockKeys('studio-b', '2026-09-07');
    expect(a).not.toEqual(b);
  });
});
