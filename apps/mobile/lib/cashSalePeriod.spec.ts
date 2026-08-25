import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addBillingInterval,
  formatCashSalePeriodLabel,
  immediateCashSalePeriod,
  legacyBrokenUtcDateLocalNoonPeriodStart,
} from './cashSalePeriod.ts';

const MX = 'America/Mexico_City';

describe('immediateCashSalePeriod', () => {
  it('evening Mexico City sale (UTC already next day) starts at now, not tomorrow noon', () => {
    // 2026-08-24 19:41 America/Mexico_City = 2026-08-25T01:41:00.000Z
    const saleAt = new Date('2026-08-25T01:41:00.000Z');
    const { periodStart, periodEnd } = immediateCashSalePeriod({
      billingInterval: 'MONTHLY',
      now: saleAt,
    });

    assert.equal(periodStart.toISOString(), saleAt.toISOString());
    assert.ok(periodStart.getTime() <= saleAt.getTime());

    // Reproduce the production anti-pattern under America/Mexico_City local noon parsing.
    const previous = process.env.TZ;
    process.env.TZ = MX;
    try {
      const broken = new Date(legacyBrokenUtcDateLocalNoonPeriodStart(saleAt));
      assert.ok(broken.getTime() > saleAt.getTime());
      assert.notEqual(periodStart.toISOString(), broken.toISOString());
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }

    assert.equal(periodEnd.toISOString(), addBillingInterval(saleAt, 'MONTHLY').toISOString());
  });

  it('morning Mexico City sale starts at now', () => {
    // 2026-08-24 09:00 America/Mexico_City = 2026-08-24T15:00:00.000Z
    const saleAt = new Date('2026-08-24T15:00:00.000Z');
    const { periodStart } = immediateCashSalePeriod({
      billingInterval: 'MONTHLY',
      now: saleAt,
    });
    assert.equal(periodStart.toISOString(), saleAt.toISOString());
    assert.ok(periodStart.getTime() <= saleAt.getTime());
  });

  it('first cash membership and expired renewal both use now as start', () => {
    const saleAt = new Date('2026-08-25T01:41:23.000Z');
    const first = immediateCashSalePeriod({ billingInterval: 'MONTHLY', now: saleAt });
    const renewal = immediateCashSalePeriod({ billingInterval: 'MONTHLY', now: saleAt });
    assert.equal(first.periodStart.toISOString(), saleAt.toISOString());
    assert.equal(renewal.periodStart.toISOString(), saleAt.toISOString());
  });

  it('fixed-duration uses entitlementDays, not calendar month', () => {
    const saleAt = new Date('2026-08-24T18:00:00.000Z');
    const { periodEnd } = immediateCashSalePeriod({
      billingInterval: 'MONTHLY',
      entitlementDays: 45,
      now: saleAt,
    });
    assert.equal(periodEnd.toISOString(), new Date(saleAt.getTime() + 45 * 86_400_000).toISOString());
  });

  it('studio-local label stays Aug 24 even when process TZ is Auckland', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      const saleAt = new Date('2026-08-25T01:41:00.000Z');
      const { periodStart, periodEnd } = immediateCashSalePeriod({
        billingInterval: 'MONTHLY',
        now: saleAt,
      });
      const label = formatCashSalePeriodLabel(periodStart, periodEnd, MX);
      assert.equal(label.startKey, '2026-08-24');
      assert.match(label.label, /^2026-08-24 → /);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('documents early interval renewal: clients omit period so API starts at now (one-ACTIVE)', () => {
    // Preferred product (queue after current end) needs a future ACTIVE successor, which
    // the partial unique index forbids. Omitting periodStart is still correct for the
    // Miguel/Alvaro bug (immediate start) and for fixed-duration queueing on the API.
    const saleAt = new Date('2026-08-25T01:41:00.000Z');
    const { periodStart } = immediateCashSalePeriod({
      billingInterval: 'MONTHLY',
      now: saleAt,
    });
    assert.equal(periodStart.toISOString(), saleAt.toISOString());
  });
});
