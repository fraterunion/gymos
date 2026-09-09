import { SubscriptionStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { MembershipUsageService } from './membership-usage.service';

/**
 * MM-5.1 — service-level coverage of the SCOPED (subscriptionId != null) paths.
 * The scoped paths were previously reached only through fully mocked usage services
 * in booking/attendance specs; these tests exercise the real pipeline:
 * one leg-row query + one candidate query → collapse → deterministic ownership.
 */

const STUDIO = 'studio-1';
const USER = 'user-1';
const PERIOD_START = new Date('2026-09-01T00:00:00Z');
const PERIOD_END = new Date('2026-10-01T00:00:00Z');
const CLASS_AT = new Date('2026-09-10T12:00:00Z');

type LegRow = {
  class_id: string;
  starts_at: Date;
  class_template_id: string;
  category: string | null;
  src: 'booking' | 'attendance';
  subscription_id: string | null;
};

function legRow(overrides: Partial<LegRow>): LegRow {
  return {
    class_id: 'class-1',
    starts_at: CLASS_AT,
    class_template_id: 'tpl-1',
    category: null,
    src: 'booking',
    subscription_id: null,
    ...overrides,
  };
}

function candidateRow(overrides: {
  id: string;
  classCredits?: number | null;
  entitlementEndsAt?: Date | null;
  createdAt?: Date;
  status?: SubscriptionStatus;
}) {
  return {
    id: overrides.id,
    status: overrides.status ?? SubscriptionStatus.ACTIVE,
    createdAt: overrides.createdAt ?? new Date('2026-08-01T00:00:00Z'),
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    entitlementEndsAt: overrides.entitlementEndsAt ?? null,
    membershipPlan: {
      classCredits: overrides.classCredits ?? null,
      allClassesAccess: true,
      allowedCategories: [],
      classTemplateAccess: [],
    },
  };
}

function makeClient(legRows: LegRow[], candidateRows: ReturnType<typeof candidateRow>[]) {
  return {
    $queryRaw: jest.fn().mockResolvedValue(legRows),
    subscription: { findMany: jest.fn().mockResolvedValue(candidateRows) },
  };
}

const service = new MembershipUsageService({} as PrismaService);

describe('MembershipUsageService — scoped counting (MM-5.1)', () => {
  it('legacy NULL event with two overlapping memberships lands in exactly ONE ledger (query symmetry)', async () => {
    const legs = [legRow({ src: 'booking' }), legRow({ src: 'attendance' })];
    const candidates = [
      candidateRow({ id: 'sub-full', classCredits: null }),
      candidateRow({ id: 'sub-booty', classCredits: 4, entitlementEndsAt: new Date('2026-09-20T00:00:00Z') }),
    ];

    const clientA = makeClient(legs, candidates);
    const clientB = makeClient(legs, candidates);
    const countFull = await service.countConsumedClasses(
      clientA as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-full',
    );
    const countBooty = await service.countConsumedClasses(
      clientB as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-booty',
    );

    // Unlimited-first precedence: the Full plan absorbs legacy history; Booty is untouched.
    expect(countFull).toBe(1);
    expect(countBooty).toBe(0);
    expect(countFull + countBooty).toBe(1);
  });

  it('cross-leg regression: booking explicit A + attendance NULL never double-counts into B', async () => {
    // The pre-MM-5.1 SQL counted this class for A (booking leg) AND for B (NULL attendance leg).
    const legs = [
      legRow({ src: 'booking', subscription_id: 'sub-a' }),
      legRow({ src: 'attendance', subscription_id: null }),
    ];
    const candidates = [
      candidateRow({ id: 'sub-a', classCredits: 8 }),
      candidateRow({ id: 'sub-b', classCredits: 4 }),
    ];

    const countA = await service.countConsumedClasses(
      makeClient(legs, candidates) as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-a',
    );
    const countB = await service.countConsumedClasses(
      makeClient(legs, candidates) as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-b',
    );

    expect(countA).toBe(1);
    expect(countB).toBe(0);
  });

  it('manual attendance without a booking (matrix T) is inferred like any legacy event', async () => {
    const legs = [legRow({ src: 'attendance', subscription_id: null })];
    const candidates = [candidateRow({ id: 'sub-only', classCredits: 8 })];

    const count = await service.countConsumedClasses(
      makeClient(legs, candidates) as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-only',
    );
    expect(count).toBe(1);
  });

  it('zero window-covering candidates (matrix V) contributes to no ledger', async () => {
    const legs = [legRow({})];
    const candidates = [candidateRow({ id: 'sub-late' })];
    candidates[0]!.currentPeriodStart = new Date('2026-09-15T00:00:00Z');

    const count = await service.countConsumedClasses(
      makeClient(legs, candidates) as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-late',
    );
    expect(count).toBe(0);
  });

  it('scoped count issues exactly TWO bounded queries regardless of event count (no N+1)', async () => {
    const legs = Array.from({ length: 12 }, (_, i) =>
      legRow({ class_id: `class-${i}`, src: i % 2 === 0 ? 'booking' : 'attendance' }),
    );
    const client = makeClient(legs, [candidateRow({ id: 'sub-only' })]);

    await service.countConsumedClasses(
      client as never, STUDIO, USER, PERIOD_START, PERIOD_END, 'sub-only',
    );
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.subscription.findMany).toHaveBeenCalledTimes(1);
    expect(client.subscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studioId: STUDIO, userId: USER } }),
    );
  });

  it('unscoped count keeps the legacy single-query path and never loads candidates', async () => {
    const client = {
      $queryRaw: jest.fn().mockResolvedValue([{ count: BigInt(3) }]),
      subscription: { findMany: jest.fn() },
    };

    const count = await service.countConsumedClasses(
      client as never, STUDIO, USER, PERIOD_START, PERIOD_END,
    );
    expect(count).toBe(3);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.subscription.findMany).not.toHaveBeenCalled();
  });
});

describe('MembershipUsageService — scoped isClassConsumedInPeriod (MM-5.1)', () => {
  it('explicit attribution is authoritative in both query directions', async () => {
    const legs = [legRow({ src: 'booking', subscription_id: 'sub-b' })];
    const candidates = [
      candidateRow({ id: 'sub-a', classCredits: null }),
      candidateRow({ id: 'sub-b', classCredits: 4 }),
    ];

    const consumedForB = await service.isClassConsumedInPeriod(
      makeClient(legs, candidates) as never, STUDIO, USER, 'class-1', PERIOD_START, PERIOD_END, 'sub-b',
    );
    // Even though sub-a (unlimited) would win inference, the explicit row is never re-inferred.
    const consumedForA = await service.isClassConsumedInPeriod(
      makeClient(legs, candidates) as never, STUDIO, USER, 'class-1', PERIOD_START, PERIOD_END, 'sub-a',
    );

    expect(consumedForB).toBe(true);
    expect(consumedForA).toBe(false);
  });

  it('legacy NULL class is "consumed" only for its ONE inferred owner', async () => {
    const legs = [legRow({ src: 'booking', subscription_id: null })];
    const candidates = [
      candidateRow({ id: 'sub-full', classCredits: null }),
      candidateRow({ id: 'sub-booty', classCredits: 4 }),
    ];

    const forFull = await service.isClassConsumedInPeriod(
      makeClient(legs, candidates) as never, STUDIO, USER, 'class-1', PERIOD_START, PERIOD_END, 'sub-full',
    );
    const forBooty = await service.isClassConsumedInPeriod(
      makeClient(legs, candidates) as never, STUDIO, USER, 'class-1', PERIOD_START, PERIOD_END, 'sub-booty',
    );

    expect(forFull).toBe(true);
    expect(forBooty).toBe(false);
  });

  it('agrees with countConsumedClasses (idempotent re-check can never diverge from counting)', async () => {
    const legs = [
      legRow({ src: 'booking', subscription_id: null }),
      legRow({ src: 'attendance', subscription_id: null }),
    ];
    const candidates = [
      candidateRow({ id: 'sub-a', classCredits: 4, createdAt: new Date('2026-08-01T00:00:00Z') }),
      candidateRow({ id: 'sub-b', classCredits: 4, createdAt: new Date('2026-08-15T00:00:00Z') }),
    ];

    for (const sub of ['sub-a', 'sub-b']) {
      const consumed = await service.isClassConsumedInPeriod(
        makeClient(legs, candidates) as never, STUDIO, USER, 'class-1', PERIOD_START, PERIOD_END, sub,
      );
      const count = await service.countConsumedClasses(
        makeClient(legs, candidates) as never, STUDIO, USER, PERIOD_START, PERIOD_END, sub,
      );
      expect(consumed).toBe(count === 1);
    }
  });
});
