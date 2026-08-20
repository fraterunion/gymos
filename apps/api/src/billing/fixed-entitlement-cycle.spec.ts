import { buildPaidFixedEntitlementCycle, cycleContains, DAY_MS } from './fixed-entitlement-cycle';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const start = new Date('2026-08-18T18:00:00.000Z');
const end = new Date(start.getTime() + 45 * DAY_MS);

describe('fixed-duration renewable entitlement cycles', () => {
  it('first paid purchase creates exactly one 45-day, four-credit cycle', () => {
    expect(buildPaidFixedEntitlementCycle({ periodStart: start, periodEnd: end, entitlementDays: 45, creditLimit: 4 }))
      .toEqual({ startsAt: start, endsAt: end, creditLimit: 4 });
  });
  it('day 30 remains in the original cycle', () => expect(cycleContains({ startsAt: start, endsAt: end, creditLimit: 4 }, new Date(start.getTime() + 30 * DAY_MS))).toBe(true));
  it('day 44 remains in the original cycle', () => expect(cycleContains({ startsAt: start, endsAt: end, creditLimit: 4 }, new Date(start.getTime() + 44 * DAY_MS))).toBe(true));
  it('day 45 is the exclusive boundary', () => expect(cycleContains({ startsAt: start, endsAt: end, creditLimit: 4 }, end)).toBe(false));
  it('successful renewal starts at the previous end with fresh four credits', () => {
    const nextEnd = new Date(end.getTime() + 45 * DAY_MS);
    expect(buildPaidFixedEntitlementCycle({ periodStart: end, periodEnd: nextEnd, entitlementDays: 45, creditLimit: 4, previousCycleEnd: end }))
      .toEqual({ startsAt: end, endsAt: nextEnd, creditLimit: 4 });
  });
  it('does not carry unused credits into the next cycle', () => {
    const next = buildPaidFixedEntitlementCycle({ periodStart: end, periodEnd: new Date(end.getTime() + 45 * DAY_MS), entitlementDays: 45, creditLimit: 4, previousCycleEnd: end });
    expect(next.creditLimit).toBe(4);
  });
  it('rejects a monthly provider period for a 45-day entitlement', () => {
    expect(() => buildPaidFixedEntitlementCycle({ periodStart: start, periodEnd: new Date(start.getTime() + 31 * DAY_MS), entitlementDays: 45, creditLimit: 4 })).toThrow(/45/);
  });
  it('rejects overlapping late webhook periods', () => {
    expect(() => buildPaidFixedEntitlementCycle({ periodStart: new Date(end.getTime() - DAY_MS), periodEnd: new Date(end.getTime() + 44 * DAY_MS), entitlementDays: 45, creditLimit: 4, previousCycleEnd: end })).toThrow(/overlaps/);
  });
  it('permits a non-overlapping late webhook period', () => {
    expect(buildPaidFixedEntitlementCycle({ periodStart: end, periodEnd: new Date(end.getTime() + 45 * DAY_MS), entitlementDays: 45, creditLimit: 4, previousCycleEnd: end }).startsAt).toEqual(end);
  });

  it('enforces immutable, positive, non-overlapping ledger rows in PostgreSQL', () => {
    const sql = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260820020000_fixed_entitlement_cycles/migration.sql',
    ), 'utf8');
    expect(sql).toContain('"ends_at" > "starts_at"');
    expect(sql).toContain('"credit_limit" IS NULL OR "credit_limit" > 0');
    expect(sql).toContain("tsrange(existing.\"starts_at\", existing.\"ends_at\", '[)')");
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain("TG_OP <> 'INSERT'");
  });

  it('backfills exact subscription windows without rewriting subscription state', () => {
    const sql = readFileSync(resolve(
      process.cwd(),
      'prisma/migrations/20260820020000_fixed_entitlement_cycles/migration.sql',
    ), 'utf8');
    expect(sql).toContain('s."current_period_start", s."entitlement_ends_at"');
    expect(sql).toContain('p."class_credits", s."source"');
    expect(sql).not.toMatch(/UPDATE\s+"subscriptions"/i);
    expect(sql).not.toMatch(/UPDATE\s+"bookings"/i);
    expect(sql).not.toMatch(/UPDATE\s+"payments"/i);
    expect(sql).not.toMatch(/UPDATE\s+"attendances"/i);
  });
});
