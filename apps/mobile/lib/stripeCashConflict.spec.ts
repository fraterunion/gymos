import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatPaidThroughDate,
  parseStripeRenewableConflict,
  STRIPE_RENEWABLE_CONFLICT_CODE,
} from './stripeCashConflict.ts';

describe('parseStripeRenewableConflict', () => {
  it('parses structured 409 body', () => {
    const body = {
      statusCode: 409,
      code: STRIPE_RENEWABLE_CONFLICT_CODE,
      message: 'Este miembro tiene una suscripción activa en Stripe.',
      stripeConflict: {
        localSubscriptionId: 'sub_local',
        stripeSubscriptionId: 'sub_stripe',
        planId: 'plan_pro',
        planName: 'Pro',
        status: 'ACTIVE',
        currentPeriodStart: '2026-07-30T04:50:48.000Z',
        currentPeriodEnd: '2026-08-30T04:50:48.000Z',
        cancelAtPeriodEnd: false,
        pendingCashTransitionId: null,
        allowedResolutions: ['cancel_at_period_end', 'cancel_immediately'],
      },
    };
    const parsed = parseStripeRenewableConflict({
      message: body.message,
      status: 409,
      body,
    });
    assert.ok(parsed);
    assert.equal(parsed!.planName, 'Pro');
    assert.equal(parsed!.allowedResolutions.length, 2);
  });

  it('returns null for unrelated 409', () => {
    assert.equal(
      parseStripeRenewableConflict({ message: 'Ya existe una membresía activa', status: 409 }),
      null,
    );
  });
});

describe('formatPaidThroughDate', () => {
  it('formats ISO in studio timezone', () => {
    // 18:00Z = midday America/Mexico_City on the same calendar date
    const label = formatPaidThroughDate('2026-08-30T18:00:00.000Z', 'America/Mexico_City');
    assert.match(label, /30/);
    assert.match(label, /agosto/i);
  });
});
