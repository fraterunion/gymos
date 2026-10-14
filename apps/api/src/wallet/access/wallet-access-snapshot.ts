import { DayPassStatus, SubscriptionSource, SubscriptionStatus, type SubscriptionEndReason } from '@prisma/client';
import { addDaysToDateKey, getStudioLocalDateKey, studioLocalDateKeyToUtcAnchor } from '../../common/date/studio-local-date';
import { classifyDayPassDate } from '../../day-passes/day-pass-dates';
import { SUPERSESSION_END_REASONS } from '../../billing/subscription-end-reason';
import { selectPrimaryMembership } from '../../memberships/membership-compatibility';
import {
  deriveMembershipLifecycle,
  type MembershipAccessState,
  type MembershipLifecycleStatus,
} from '../../memberships/membership-entitlement';

/**
 * WalletAccessSnapshot — what a member's Wallet pass may truthfully SAY about their membership
 * at one instant. It is presentation data, never an access decision: check-in authorization
 * stays in CheckInsService / BookingAccessService, unchanged.
 *
 * Every entitlement fact here comes from the canonical primitives (deriveMembershipLifecycle,
 * selectPrimaryMembership). Subscription.status is never read on its own to decide whether a
 * membership is current — a cash row keeps status ACTIVE after its paid period ends (October 2026
 * incident), and only the dates say it is over.
 *
 * Pure: the clock and the studio timezone are explicit inputs, so the same input always yields
 * the same snapshot.
 */
export const WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export type WalletAccessPlanInput = {
  id: string;
  name: string;
  classCredits: number | null;
  allClassesAccess: boolean;
  entitlementDays: number | null;
  openGymAccess: boolean;
  openGymWindowStart: string | null;
  openGymWindowEnd: string | null;
};

export type WalletAccessSubscriptionInput = {
  id: string;
  status: SubscriptionStatus;
  source: SubscriptionSource;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  entitlementEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  exclusiveGroupKey: string | null;
  supersededBySubscriptionId: string | null;
  endReason: SubscriptionEndReason | null;
  createdAt: Date;
  plan: WalletAccessPlanInput;
};

export type WalletAccessDayPassInput = {
  id: string;
  status: DayPassStatus;
  /** UTC instant of studio-local midnight of the pass date (see studio-local-date.ts). */
  validForDate: Date;
};

export type WalletAccessInput = {
  studio: { id: string; timezone: string };
  member: { userId: string; firstName: string; lastName: string };
  credential: { id: string; revokedAt: Date | null };
  /** False when the member no longer has a non-deleted StudioMembership in this studio. */
  studioMembershipActive: boolean;
  subscriptions: readonly WalletAccessSubscriptionInput[];
  dayPasses: readonly WalletAccessDayPassInput[];
};

export type WalletAccessOverallState =
  /** At least one membership is entitled right now. */
  | 'ACCESS_VALID'
  /** No entitled membership, but an ACTIVE day pass for studio-local today. */
  | 'DAY_PASS_TODAY'
  /** Nothing entitled; a membership is PAST_DUE (payment recovery). */
  | 'PAYMENT_PENDING'
  /** Nothing entitled; a membership exists that has not started yet. */
  | 'SCHEDULED'
  /** Nothing entitled; the member had memberships and they ended (expired, canceled, paused). */
  | 'INACTIVE'
  /** No memberships at all (or no longer a member of this studio). */
  | 'NO_MEMBERSHIP'
  /** The pass's credential was revoked (member reissued their pass). */
  | 'CREDENTIAL_REVOKED';

export type WalletRenewalMode = 'AUTO_RENEWS' | 'ENDS_AT_PERIOD_END';

export type WalletMembershipScope = {
  allClasses: boolean;
  /** Credits granted per period by the plan (NOT credits remaining). Null = unlimited classes. */
  classCredits: number | null;
  /** Gym floor (Open Gym) access granted by the plan; null when the plan has none. */
  openGym: { windowStart: string | null; windowEnd: string | null } | null;
};

export type WalletMembershipEntry = {
  subscriptionId: string;
  planId: string;
  planName: string;
  source: SubscriptionSource;
  lifecycleStatus: MembershipLifecycleStatus;
  accessState: MembershipAccessState;
  isEntitled: boolean;
  isPrimary: boolean;
  /** ISO instants of the canonical access window [effectiveStart, effectiveEnd). */
  effectiveStart: string | null;
  effectiveEnd: string | null;
  renewal: WalletRenewalMode;
  fixedDuration: boolean;
  scope: WalletMembershipScope;
};

export type WalletDayPassEntry = {
  dayPassId: string;
  /** Studio-local YYYY-MM-DD. */
  dateKey: string;
  relative: 'today' | 'upcoming';
};

export type WalletAccessSnapshot = {
  schemaVersion: typeof WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION;
  computedAt: string;
  timezone: string;
  studioId: string;
  userId: string;
  walletCredentialId: string;
  credentialState: 'ACTIVE' | 'REVOKED';
  overall: WalletAccessOverallState;
  memberDisplayName: string;
  /**
   * The membership the pass headlines: the canonical PRIMARY entitled membership when one
   * exists, otherwise the most relevant non-entitled one for the overall state.
   */
  headline: WalletMembershipEntry | null;
  /**
   * Primary entitled membership first, then the other entitled ones, then non-entitled rows
   * that matter to the member (payment pending, not started yet), then — only when nothing
   * else applies — the most recently ended one.
   */
  memberships: WalletMembershipEntry[];
  dayPasses: WalletDayPassEntry[];
  /** Earliest future instant at which this snapshot could change purely because time passed. */
  nextTransitionAt: string | null;
};

type Classified = {
  sub: WalletAccessSubscriptionInput;
  entry: WalletMembershipEntry;
  superseded: boolean;
};

function isSuperseded(sub: WalletAccessSubscriptionInput): boolean {
  return (
    sub.supersededBySubscriptionId !== null ||
    (sub.endReason !== null && SUPERSESSION_END_REASONS.includes(sub.endReason))
  );
}

function renewalMode(sub: WalletAccessSubscriptionInput): WalletRenewalMode {
  const renewableStatus = sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.TRIALING;
  return sub.source === SubscriptionSource.STRIPE && renewableStatus && !sub.cancelAtPeriodEnd
    ? 'AUTO_RENEWS'
    : 'ENDS_AT_PERIOD_END';
}

function scopeOf(plan: WalletAccessPlanInput): WalletMembershipScope {
  return {
    allClasses: plan.allClassesAccess,
    classCredits: plan.classCredits,
    openGym: plan.openGymAccess
      ? { windowStart: plan.openGymWindowStart, windowEnd: plan.openGymWindowEnd }
      : null,
  };
}

function classify(sub: WalletAccessSubscriptionInput, now: Date): Classified {
  const lifecycle = deriveMembershipLifecycle(sub, now);
  return {
    sub,
    superseded: isSuperseded(sub),
    entry: {
      subscriptionId: sub.id,
      planId: sub.plan.id,
      planName: sub.plan.name,
      source: sub.source,
      lifecycleStatus: lifecycle.lifecycleStatus,
      accessState: lifecycle.accessState,
      isEntitled: lifecycle.isEntitled,
      isPrimary: false,
      effectiveStart: lifecycle.effectiveStart?.toISOString() ?? null,
      effectiveEnd: lifecycle.effectiveEnd?.toISOString() ?? null,
      renewal: renewalMode(sub),
      fixedDuration: sub.plan.entitlementDays !== null,
      scope: scopeOf(sub.plan),
    },
  };
}

function byNewest(a: Classified, b: Classified): number {
  const diff = b.sub.createdAt.getTime() - a.sub.createdAt.getTime();
  return diff !== 0 ? diff : a.sub.id.localeCompare(b.sub.id);
}

function instant(iso: string | null): number | null {
  return iso === null ? null : new Date(iso).getTime();
}

/**
 * The canonical primary ENTITLED membership's plan name, or null when nothing is entitled.
 * The single source of truth for "which plan does this member currently hold" on a pass —
 * replaces the old newest-row-with-status-ACTIVE lookup, which kept naming a plan whose paid
 * period had already ended.
 */
export function resolveEntitledPrimaryPlanName(
  subscriptions: readonly WalletAccessSubscriptionInput[],
  now: Date,
): string | null {
  const entitled = subscriptions.filter((s) => deriveMembershipLifecycle(s, now).isEntitled);
  return selectPrimaryMembership(entitled)?.plan.name ?? null;
}

export function computeWalletAccessSnapshot(input: WalletAccessInput, now: Date): WalletAccessSnapshot {
  const base = {
    schemaVersion: WALLET_ACCESS_SNAPSHOT_SCHEMA_VERSION,
    computedAt: now.toISOString(),
    timezone: input.studio.timezone,
    studioId: input.studio.id,
    userId: input.member.userId,
    walletCredentialId: input.credential.id,
    memberDisplayName: `${input.member.firstName} ${input.member.lastName}`.trim(),
  };

  // A revoked credential's pass says nothing about the membership: it only tells the holder
  // the pass was replaced. The new credential carries the live state.
  if (input.credential.revokedAt !== null) {
    return {
      ...base,
      credentialState: 'REVOKED',
      overall: 'CREDENTIAL_REVOKED',
      headline: null,
      memberships: [],
      dayPasses: [],
      nextTransitionAt: null,
    };
  }

  if (!input.studioMembershipActive) {
    return {
      ...base,
      credentialState: 'ACTIVE',
      overall: 'NO_MEMBERSHIP',
      headline: null,
      memberships: [],
      dayPasses: [],
      nextTransitionAt: null,
    };
  }

  const classified = input.subscriptions.map((s) => classify(s, now));

  const entitled = classified.filter((c) => c.entry.isEntitled);
  const primarySub = selectPrimaryMembership(entitled.map((c) => c.sub));
  const primary = entitled.find((c) => c.sub.id === primarySub?.id) ?? null;
  if (primary) primary.entry.isPrimary = true;
  const otherEntitled = entitled.filter((c) => c !== primary).sort(byNewest);

  const notEntitled = classified.filter((c) => !c.entry.isEntitled && !c.superseded);
  const pastDue = notEntitled.filter((c) => c.sub.status === SubscriptionStatus.PAST_DUE).sort(byNewest);
  const upcoming = notEntitled
    .filter((c) => c.entry.accessState === 'NOT_STARTED')
    .sort((a, b) => (instant(a.entry.effectiveStart) ?? Number.MAX_SAFE_INTEGER) - (instant(b.entry.effectiveStart) ?? Number.MAX_SAFE_INTEGER));
  const ended = notEntitled
    .filter((c) => c.sub.status !== SubscriptionStatus.PAST_DUE && c.entry.accessState !== 'NOT_STARTED')
    .sort((a, b) => {
      const byEnd = (instant(b.entry.effectiveEnd) ?? 0) - (instant(a.entry.effectiveEnd) ?? 0);
      return byEnd !== 0 ? byEnd : byNewest(a, b);
    });

  const todayKey = getStudioLocalDateKey(now, input.studio.timezone);
  const dayPasses: WalletDayPassEntry[] = input.dayPasses
    .filter((d) => d.status === DayPassStatus.ACTIVE)
    .map((d) => {
      const dateKey = getStudioLocalDateKey(d.validForDate, input.studio.timezone);
      return { dayPassId: d.id, dateKey, relative: classifyDayPassDate(dateKey, todayKey) };
    })
    .filter((d): d is WalletDayPassEntry => d.relative !== 'past')
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.dayPassId.localeCompare(b.dayPassId));
  const dayPassToday = dayPasses.some((d) => d.relative === 'today');

  let overall: WalletAccessOverallState;
  let headline: Classified | null;
  if (primary) {
    overall = 'ACCESS_VALID';
    headline = primary;
  } else if (dayPassToday) {
    overall = 'DAY_PASS_TODAY';
    headline = null;
  } else if (pastDue.length > 0) {
    overall = 'PAYMENT_PENDING';
    headline = pastDue[0]!;
  } else if (upcoming.length > 0) {
    overall = 'SCHEDULED';
    headline = upcoming[0]!;
  } else if (ended.length > 0) {
    overall = 'INACTIVE';
    headline = ended[0]!;
  } else {
    overall = 'NO_MEMBERSHIP';
    headline = null;
  }

  const memberships: WalletMembershipEntry[] = [
    ...(primary ? [primary.entry] : []),
    ...otherEntitled.map((c) => c.entry),
    ...pastDue.map((c) => c.entry),
    ...upcoming.map((c) => c.entry),
    ...(overall === 'INACTIVE' && headline ? [headline.entry] : []),
  ];

  // Time-only transitions: an entitled window ending, a not-yet-started window opening, and
  // studio-local day boundaries for day passes. Events (payments, sales, staff actions) are
  // handled by whoever changes the data, not by this value.
  const candidates: number[] = [];
  const nowMs = now.getTime();
  for (const c of entitled) {
    const end = instant(c.entry.effectiveEnd);
    if (end !== null && end > nowMs) candidates.push(end);
  }
  for (const c of upcoming) {
    const start = instant(c.entry.effectiveStart);
    if (start !== null && start > nowMs) candidates.push(start);
  }
  for (const d of dayPasses) {
    const boundaryKey = d.relative === 'today' ? addDaysToDateKey(d.dateKey, 1) : d.dateKey;
    const boundary = studioLocalDateKeyToUtcAnchor(boundaryKey, input.studio.timezone).getTime();
    if (boundary > nowMs) candidates.push(boundary);
  }
  const nextTransitionAt = candidates.length > 0 ? new Date(Math.min(...candidates)).toISOString() : null;

  return {
    ...base,
    credentialState: 'ACTIVE',
    overall,
    headline: headline?.entry ?? null,
    memberships,
    dayPasses,
    nextTransitionAt,
  };
}
