import { createHash } from 'node:crypto';
import type { SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { deriveMembershipLifecycle } from '../memberships/membership-entitlement';
import { matchesLifecycleFilter, matchesPaymentSource, type MemberLifecycleFilter } from '../members/member-operations';

export type CampaignFilters = {
  planIds?: string[];
  statuses?: MemberLifecycleFilter[];
  paymentSources?: Array<SubscriptionSource | 'NONE'>;
};

/**
 * Idempotency keys protect both the message and its audience. A replay with the
 * same key but different filters/selection must never silently reuse the old
 * recipient snapshot and send to a group the admin did not just confirm.
 * Treat arrays as sets so equivalent selections can safely retry.
 */
export function campaignAudienceSignature(input: {
  filters?: CampaignFilters | null;
  includeUserIds?: string[] | null;
  excludeUserIds?: string[] | null;
  allMembers?: boolean | null;
}): string {
  const normalized = (ids?: string[] | null) => [...new Set(ids ?? [])].sort();
  return JSON.stringify({
    allMembers: input.allMembers === true,
    filters: {
      planIds: normalized(input.filters?.planIds),
      statuses: normalized(input.filters?.statuses),
      paymentSources: normalized(input.filters?.paymentSources),
    },
    includeUserIds: normalized(input.includeUserIds),
    excludeUserIds: normalized(input.excludeUserIds),
  });
}

export type RecipientSubscription = {
  membershipPlanId: string;
  planName: string;
  source: SubscriptionSource;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

export type RecipientCandidate = {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  subscriptions: RecipientSubscription[];
};

export type ResolvedRecipient = {
  userId: string;
  email: string;
  name: string;
  planName: string | null;
  lifecycleStatus: string | null;
  paymentSource: string | null;
};

/** Stable identifier for the EXACT (user,email) delivery snapshot, regardless of order. */
export function recipientSnapshotFingerprint(recipients: ReadonlyArray<Pick<ResolvedRecipient, 'userId' | 'email'>>): string {
  const normalized = recipients.map((r) => [r.userId, r.email.trim().toLowerCase()] as const);
  normalized.sort((a,b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasNarrowingFilters(filters: CampaignFilters): boolean {
  return Boolean(filters.planIds?.length || filters.statuses?.length || filters.paymentSources?.length);
}

function subscriptionMatches(sub: RecipientSubscription, filters: CampaignFilters, now: Date): boolean {
  if (filters.planIds?.length && !filters.planIds.includes(sub.membershipPlanId)) return false;
  const lifecycle = deriveMembershipLifecycle(sub, now).lifecycleStatus;
  if (filters.statuses?.length && !filters.statuses.some((status) => matchesLifecycleFilter(lifecycle, status))) {
    return false;
  }
  if (filters.paymentSources?.length && !filters.paymentSources.some((source) => matchesPaymentSource(sub.source, source))) {
    return false;
  }
  return true;
}

function memberMatches(member: RecipientCandidate, filters: CampaignFilters, now: Date): boolean {
  if (!hasNarrowingFilters(filters)) return true;
  if (member.subscriptions.some((sub) => subscriptionMatches(sub, filters, now))) return true;
  const noSubscription = member.subscriptions.length === 0;
  if (!noSubscription || filters.planIds?.length) return false;
  const statusOk = !filters.statuses?.length || filters.statuses.includes('NONE');
  const paymentOk = !filters.paymentSources?.length || filters.paymentSources.includes('NONE');
  return statusOk && paymentOk;
}

export function resolveCampaignRecipients(input: {
  members: RecipientCandidate[];
  filters: CampaignFilters;
  includeUserIds: string[];
  excludeUserIds: string[];
  allMembers: boolean;
  suppressedEmails: ReadonlySet<string>;
  now: Date;
}): {
  recipients: ResolvedRecipient[];
  suppressed: Array<{ email: string; userId: string }>;
  invalidEmails: number;
} {
  const filters = input.filters;
  const excluded = new Set(input.excludeUserIds);
  const included = new Set(input.includeUserIds);
  const narrowing = hasNarrowingFilters(filters);
  const byEmail = new Map<string, ResolvedRecipient>();
  const suppressed: Array<{ email: string; userId: string }> = [];
  let invalidEmails = 0;

  for (const member of input.members) {
    const filterMatch = input.allMembers || (narrowing && memberMatches(member, filters, input.now));
    const selected = included.has(member.userId) || filterMatch;
    if (!selected || excluded.has(member.userId)) continue;
    const email = member.email.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) {
      invalidEmails += 1;
      continue;
    }
    if (input.suppressedEmails.has(email)) {
      suppressed.push({ email, userId: member.userId });
      continue;
    }
    if (byEmail.has(email)) continue;
    const matched = member.subscriptions.find((sub) => subscriptionMatches(sub, filters, input.now)) ?? member.subscriptions[0];
    const lifecycle = matched ? deriveMembershipLifecycle(matched, input.now).lifecycleStatus : null;
    byEmail.set(email, {
      userId: member.userId,
      email,
      name: `${member.firstName} ${member.lastName}`.trim(),
      planName: matched?.planName ?? null,
      lifecycleStatus: lifecycle,
      paymentSource: matched?.source ?? null,
    });
  }

  return { recipients: [...byEmail.values()], suppressed, invalidEmails };
}
