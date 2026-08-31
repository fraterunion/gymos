import {
  GYMOS_RENEWAL_IDEMPOTENCY_PREFIX,
  GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX,
  STRIPE_RENEWAL_DISABLED,
  STRIPE_RENEWAL_EXTERNAL_CHANGE,
  STRIPE_RENEWAL_REACTIVATED,
} from './stripe-renewal-audit.constants';
import {
  buildGymosRenewalIdempotencyKey,
  buildGymosStripeToCashIdempotencyKey,
  buildGymosStripeToCashImmediateIdempotencyKey,
  buildGymosStripeToCashPeriodEndIdempotencyKey,
  describeStripeRenewalTimelineEvent,
  gymosRenewalActionForCancel,
  isGymosInitiatedStripeIdempotencyKey,
} from './stripe-renewal-audit.utils';

describe('stripe-renewal-audit.utils', () => {
  it('builds GymOS renewal and deterministic Stripe→Cash idempotency keys', () => {
    expect(buildGymosRenewalIdempotencyKey('abc')).toBe(`${GYMOS_RENEWAL_IDEMPOTENCY_PREFIX}abc`);
    expect(buildGymosStripeToCashIdempotencyKey('xyz')).toBe(
      `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}xyz`,
    );
    expect(buildGymosStripeToCashPeriodEndIdempotencyKey('sub_1')).toBe(
      `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}sub_1_cancel_at_period_end`,
    );
    expect(buildGymosStripeToCashImmediateIdempotencyKey('sub_1')).toBe(
      `${GYMOS_STRIPE_TO_CASH_IDEMPOTENCY_PREFIX}sub_1_cancel_immediate`,
    );
    expect(isGymosInitiatedStripeIdempotencyKey(`${GYMOS_RENEWAL_IDEMPOTENCY_PREFIX}1`)).toBe(true);
    expect(
      isGymosInitiatedStripeIdempotencyKey(
        buildGymosStripeToCashPeriodEndIdempotencyKey('sub_x'),
      ),
    ).toBe(true);
    expect(isGymosInitiatedStripeIdempotencyKey(null)).toBe(false);
    expect(isGymosInitiatedStripeIdempotencyKey('req_portal')).toBe(false);
  });

  it('maps cancel flag to GymOS audit actions', () => {
    expect(gymosRenewalActionForCancel(true)).toBe(STRIPE_RENEWAL_DISABLED);
    expect(gymosRenewalActionForCancel(false)).toBe(STRIPE_RENEWAL_REACTIVATED);
  });

  it('describes GymOS and external timeline copy without inventing actors', () => {
    const disabled = describeStripeRenewalTimelineEvent({
      action: STRIPE_RENEWAL_DISABLED,
      metadata: {
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        actorRole: 'OWNER',
      },
      actorName: 'Fernando Mañon · OWNER',
    });
    expect(disabled.title).toBe('Renovación automática desactivada');
    expect(disabled.description).toContain('Desde GymOS');
    expect(disabled.actor).toBe('Fernando Mañon · OWNER');

    const external = describeStripeRenewalTimelineEvent({
      action: STRIPE_RENEWAL_EXTERNAL_CHANGE,
      metadata: {
        previousCancelAtPeriodEnd: false,
        newCancelAtPeriodEnd: true,
        cancellationFeedback: 'unused',
      },
      actorName: null,
    });
    expect(external.title).toBe('Renovación modificada desde Stripe');
    expect(external.description).toContain('Origen externo · actor no identificado');
    expect(external.description).toContain('Stripe reportó feedback: unused');
    expect(external.description).not.toMatch(/Renata|miembro cancel/i);
    expect(external.actor).toBeNull();
  });
});
