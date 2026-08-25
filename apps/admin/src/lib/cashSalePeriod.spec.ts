import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  immediateCashSalePeriod,
  resolveCashSalePeriodPayload,
} from './cashSalePeriod.ts';

const MX = 'America/Mexico_City';

describe('admin resolveCashSalePeriodPayload', () => {
  it('omits period for today in studio TZ (immediate cash / API defaulting)', () => {
    const now = new Date('2026-08-25T01:41:00.000Z'); // still Aug 24 in MX
    const payload = resolveCashSalePeriodPayload({
      periodStartDateKey: '2026-08-24',
      periodEndDateKey: '2026-09-24',
      timeZone: MX,
      now,
    });
    assert.deepEqual(payload, { mode: 'immediate', omitPeriod: true });
  });

  it('schedules future date keys with studio-local midnight, not device noon', () => {
    const now = new Date('2026-08-24T15:00:00.000Z');
    const payload = resolveCashSalePeriodPayload({
      periodStartDateKey: '2026-08-26',
      periodEndDateKey: '2026-09-26',
      timeZone: MX,
      now,
    });
    assert.equal(payload.mode, 'scheduled');
    if (payload.mode !== 'scheduled') return;
    assert.equal(payload.periodStartIso, '2026-08-26T06:00:00.000Z');
    assert.ok(new Date(payload.periodEndIso).getTime() > new Date(payload.periodStartIso).getTime());
  });

  it('immediate helper starts at sale instant for MX evening UTC rollover', () => {
    const saleAt = new Date('2026-08-25T01:41:00.000Z');
    const { periodStart } = immediateCashSalePeriod({
      billingInterval: 'MONTHLY',
      now: saleAt,
    });
    assert.equal(periodStart.toISOString(), saleAt.toISOString());
  });
});
