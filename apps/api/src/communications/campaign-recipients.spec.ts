import { SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { campaignAudienceSignature, resolveCampaignRecipients, type RecipientCandidate } from './campaign-recipients';

function member(partial: Partial<RecipientCandidate> & Pick<RecipientCandidate, 'userId' | 'email'>): RecipientCandidate {
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    subscriptions: [],
    ...partial,
  };
}

const now = new Date('2026-10-28T18:00:00.000Z');

describe('campaign recipient resolution', () => {
  const basic = member({
    userId: 'u-basic',
    email: 'Basic@Ares.test',
    subscriptions: [{
      membershipPlanId: 'plan-basic',
      planName: 'Basic',
      source: SubscriptionSource.CASH,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-10-01'),
      currentPeriodEnd: new Date('2026-11-01'),
      entitlementEndsAt: null,
      cancelAtPeriodEnd: false,
    }],
  });
  const full = member({
    userId: 'u-full',
    email: 'full@ares.test',
    firstName: 'Grace',
    subscriptions: [{
      membershipPlanId: 'plan-full',
      planName: 'Full',
      source: SubscriptionSource.STRIPE,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-10-01'),
      currentPeriodEnd: new Date('2026-11-01'),
      entitlementEndsAt: null,
      cancelAtPeriodEnd: false,
    }, {
      membershipPlanId: 'plan-booty',
      planName: 'Booty',
      source: SubscriptionSource.CASH,
      status: SubscriptionStatus.ACTIVE,
      currentPeriodStart: new Date('2026-10-01'),
      currentPeriodEnd: new Date('2026-11-15'),
      entitlementEndsAt: null,
      cancelAtPeriodEnd: false,
    }],
  });

  it('combines plan and payment filters and dedupes email case', () => {
    const result = resolveCampaignRecipients({
      members: [basic, { ...basic, userId: 'u-dup', email: 'basic@ares.test' }, full],
      filters: { planIds: ['plan-basic'], paymentSources: ['CASH'] },
      includeUserIds: [],
      excludeUserIds: [],
      allMembers: false,
      suppressedEmails: new Set(),
      now,
    });
    expect(result.recipients.map((row) => row.userId)).toEqual(['u-basic']);
  });

  it('does not treat a sibling membership as a match', () => {
    const result = resolveCampaignRecipients({
      members: [full],
      filters: { planIds: ['plan-full'], paymentSources: ['CASH'] },
      includeUserIds: [],
      excludeUserIds: [],
      allMembers: false,
      suppressedEmails: new Set(),
      now,
    });
    expect(result.recipients).toHaveLength(0);
  });

  it('includes an explicit member and drops an exclusion and a suppression', () => {
    const result = resolveCampaignRecipients({
      members: [basic, full],
      filters: { planIds: ['plan-basic'] },
      includeUserIds: ['u-full'],
      excludeUserIds: ['u-basic'],
      allMembers: false,
      suppressedEmails: new Set(['full@ares.test']),
      now,
    });
    expect(result.recipients).toHaveLength(0);
    expect(result.suppressed).toEqual([{ email: 'full@ares.test', userId: 'u-full' }]);
  });
});


describe('campaign idempotency audience signature', () => {
  it('is identical for equivalent filters and member selections regardless of order', () => {
    const one = campaignAudienceSignature({
      filters: { planIds: ['basic', 'pro'], statuses: ['ACTIVE'], paymentSources: ['CASH'] },
      includeUserIds: ['u2', 'u1'],
      excludeUserIds: ['u5', 'u5'],
    });
    const same = campaignAudienceSignature({
      filters: { planIds: ['pro', 'basic', 'basic'], statuses: ['ACTIVE'], paymentSources: ['CASH'] },
      includeUserIds: ['u1', 'u2'],
      excludeUserIds: ['u5'],
      allMembers: false,
    });
    expect(same).toBe(one);
  });

  it('distinguishes changed audiences with the same campaign content', () => {
    const original = campaignAudienceSignature({ filters: { planIds: ['basic'] } });
    const changedPlan = campaignAudienceSignature({ filters: { planIds: ['full'] } });
    const changedInclude = campaignAudienceSignature({ filters: { planIds: ['basic'] }, includeUserIds: ['u2'] });
    const changedExclude = campaignAudienceSignature({ filters: { planIds: ['basic'] }, excludeUserIds: ['u1'] });
    const all = campaignAudienceSignature({ filters: { planIds: ['basic'] }, allMembers: true });
    for (const other of [changedPlan, changedInclude, changedExclude, all]) {
      expect(other).not.toBe(original);
    }
  });
});
