import {
  decidePeriodEndCancel,
  localStatusBlocksPeriodEndCancel,
  readStripeCancelSnapshot,
} from './member-cancel-renewal.policy';

describe('member cancel renewal policy', () => {
  it('reads basil period end and a string customer', () => {
    const snap = readStripeCancelSnapshot({
      id: 'sub_1',
      status: 'past_due',
      customer: 'cus_1',
      cancel_at_period_end: false,
      items: { data: [{ current_period_end: 1_800_000_000 }] },
    });
    expect(snap.customerId).toBe('cus_1');
    expect(snap.currentPeriodEnd?.toISOString()).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid'])('schedules %s when renewal is still on', (status) => {
    expect(decidePeriodEndCancel({ status, cancelAtPeriodEnd: false })).toEqual({ kind: 'schedule' });
  });

  it.each(['active', 'trialing', 'past_due', 'unpaid'])('treats an already-scheduled %s subscription as success', (status) => {
    expect(decidePeriodEndCancel({ status, cancelAtPeriodEnd: true })).toEqual({ kind: 'already_scheduled' });
  });

  it.each(['paused', 'incomplete', 'incomplete_expired', 'canceled', 'weird'])(
    'explains %s instead of hiding it',
    (status) => {
      const decision = decidePeriodEndCancel({ status, cancelAtPeriodEnd: false });
      expect(decision.kind).toBe('unsupported');
      if (decision.kind === 'unsupported') {
        expect(decision.message.length).toBeGreaterThan(20);
        expect(decision.message).toMatch(/factura/i);
      }
    },
  );

  it('lets ACTIVE, TRIALING and PAST_DUE through and blocks the rest locally', () => {
    expect(localStatusBlocksPeriodEndCancel('ACTIVE')).toBeNull();
    expect(localStatusBlocksPeriodEndCancel('TRIALING')).toBeNull();
    expect(localStatusBlocksPeriodEndCancel('PAST_DUE')).toBeNull();
    expect(localStatusBlocksPeriodEndCancel('PAUSED')).toMatch(/pausa/);
    expect(localStatusBlocksPeriodEndCancel('CANCELED')).toMatch(/cancelada/);
    expect(localStatusBlocksPeriodEndCancel('SCHEDULED')).toMatch(/no empieza/);
  });
});
