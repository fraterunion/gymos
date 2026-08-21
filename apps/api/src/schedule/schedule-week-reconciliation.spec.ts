import { ClassStatus } from '@prisma/client';
import { buildWeekReconciliationPlan } from './schedule-week-reconciliation';
import type { DesiredWeekSlot, ExistingWeekRow } from './schedule-week-reconciliation';

const NOW = new Date('2026-08-20T12:00:00.000Z');

function desired(overrides: Partial<DesiredWeekSlot> = {}): DesiredWeekSlot {
  const startsAt = new Date('2026-08-25T13:00:00.000Z');
  return {
    classTemplateId: 'tpl-1',
    instructorId: 'inst-1',
    startsAt,
    endsAt: new Date('2026-08-25T14:00:00.000Z'),
    capacity: 12,
    localDateKey: '2026-08-25',
    targetWeekStart: '2026-08-24',
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingWeekRow> = {}): ExistingWeekRow {
  const startsAt = new Date('2026-08-25T13:00:00.000Z');
  return {
    id: 'row-1',
    classTemplateId: 'tpl-1',
    instructorId: 'inst-1',
    startsAt,
    endsAt: new Date('2026-08-25T14:00:00.000Z'),
    capacity: 12,
    status: ClassStatus.SCHEDULED,
    scheduleTemplateId: null,
    exceptionKind: null,
    bookingCount: 0,
    attendanceCount: 0,
    waitlistCount: 0,
    classTemplateName: 'Upperbody',
    ...overrides,
  };
}

describe('buildWeekReconciliationPlan', () => {
  it('reuses exact matches', () => {
    const plan = buildWeekReconciliationPlan([desired()], [existing()], NOW);
    expect(plan.reusedCount).toBe(1);
    expect(plan.createdCount).toBe(0);
  });

  it('creates missing desired classes', () => {
    const plan = buildWeekReconciliationPlan([desired()], [], NOW);
    expect(plan.createdCount).toBe(1);
  });

  it('updates same slot with different instructor', () => {
    const plan = buildWeekReconciliationPlan(
      [desired({ instructorId: 'inst-2' })],
      [existing()],
      NOW,
    );
    expect(plan.updatedCount).toBe(1);
    expect(plan.actions[0]?.kind).toBe('UPDATE');
  });

  it('blocks capacity below bookings', () => {
    const plan = buildWeekReconciliationPlan(
      [desired({ capacity: 1 })],
      [existing({ bookingCount: 3 })],
      NOW,
    );
    expect(plan.blockedCount).toBe(1);
    expect(plan.actions[0]?.kind).toBe('BLOCK');
  });

  it('removes empty extra classes in the future', () => {
    const plan = buildWeekReconciliationPlan(
      [],
      [existing({ id: 'extra-1', classTemplateId: 'tpl-extra' })],
      NOW,
    );
    expect(plan.removedCount).toBe(1);
    expect(plan.actions[0]?.kind).toBe('REMOVE');
  });

  it('flags extras with bookings for review', () => {
    const plan = buildWeekReconciliationPlan(
      [],
      [existing({ id: 'extra-1', bookingCount: 4 })],
      NOW,
    );
    expect(plan.reviewCount).toBe(1);
    expect(plan.actions[0]?.kind).toBe('REVIEW');
  });

  it('reactivates empty cancelled slot when desired', () => {
    const plan = buildWeekReconciliationPlan(
      [desired()],
      [existing({ status: ClassStatus.CANCELLED })],
      NOW,
    );
    expect(plan.updatedCount).toBe(1);
    expect(plan.createdCount).toBe(0);
    expect(plan.actions[0]?.kind).toBe('UPDATE');
    expect(plan.actions[0]?.patch?.status).toBe(ClassStatus.SCHEDULED);
  });

  it('blocks reactivation when cancelled slot has operational history', () => {
    const plan = buildWeekReconciliationPlan(
      [desired()],
      [existing({ status: ClassStatus.CANCELLED, bookingCount: 2 })],
      NOW,
    );
    expect(plan.blockedCount).toBe(1);
    expect(plan.actions[0]?.kind).toBe('BLOCK');
    expect(plan.createdCount).toBe(0);
  });
});
