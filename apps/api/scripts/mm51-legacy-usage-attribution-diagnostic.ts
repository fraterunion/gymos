/**
 * MM-5.1 legacy NULL usage attribution diagnostic — READ-ONLY. Performs no writes.
 *
 * Replaces the old Gate-7 dependency ("future NULL-attribution bookings must be zero
 * before MULTI_MEMBERSHIP_ENABLED=true"): attribution of legacy NULL consumption is now
 * a code invariant (see src/membership-usage/legacy-usage-attribution.ts — one canonical
 * event per class, exactly ONE deterministic owner). This tool VERIFIES what that
 * invariant will decide for real data, before anyone stacks a membership:
 *
 *   - members holding more than one subscription (any status)
 *   - their legacy NULL consumption events whose class falls inside MORE THAN ONE
 *     candidate entitlement window (the rows the old SQL double-counted)
 *   - per event: eligible candidate count, the deterministic inferred owner, and
 *     whether the choice needed the tie-break order (ambiguous-before-tie-break)
 *   - explicit-attribution conflicts (booking and attendance naming different
 *     subscriptions for the same class — impossible by design, surfaced if present)
 *   - the old Gate-7 metric (future-class NULL bookings) reported for context only
 *
 * Exit code: 1 only if explicit-attribution CONFLICTS exist (data corruption signal);
 * everything else is informational — ambiguity is resolved deterministically by code.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/mm51-legacy-usage-attribution-diagnostic.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  collapseConsumptionRows,
  candidateWindowCovers,
  resolveLegacyEventOwner,
  type ConsumptionLegRow,
  type LegacyOwnershipCandidate,
} from '../src/membership-usage/legacy-usage-attribution';
import { CREDIT_CONSUMING_BOOKING_STATUSES } from '../src/membership-usage/membership-usage.constants';

const prisma = new PrismaClient();

type MemberKey = string; // `${studioId}:${userId}`

async function main(): Promise<number> {
  console.log('=== MM-5.1 LEGACY USAGE ATTRIBUTION DIAGNOSTIC (read-only) ===');
  console.log(`Run at: ${new Date().toISOString()}\n`);

  // 1. Members with more than one subscription row (any status) — the only members
  //    for whom legacy NULL attribution can even be ambiguous.
  const multiMembers = await prisma.subscription.groupBy({
    by: ['studioId', 'userId'],
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  console.log(`Members with >1 subscription row: ${multiMembers.length}`);

  // Context metric (old Gate-7): future-class NULL consuming bookings, all members.
  const futureNullBookings = await prisma.booking.count({
    where: {
      subscriptionId: null,
      status: { in: [...CREDIT_CONSUMING_BOOKING_STATUSES] },
      scheduledClass: { startsAt: { gt: new Date() } },
    },
  });
  console.log(`Future-class NULL consuming bookings (old Gate-7 metric, informational): ${futureNullBookings}\n`);

  let totalLegacyEvents = 0;
  let eventsInOverlappingWindows = 0;
  let ambiguousBeforeTieBreak = 0;
  let unowned = 0;
  const ownerTally = new Map<string, number>();
  const conflicts: Array<{ member: MemberKey; classId: string; booking: string; attendance: string }> = [];

  for (const m of multiMembers) {
    const subs = await prisma.subscription.findMany({
      where: { studioId: m.studioId, userId: m.userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        entitlementEndsAt: true,
        membershipPlan: {
          select: {
            name: true,
            classCredits: true,
            allClassesAccess: true,
            allowedCategories: true,
            classTemplateAccess: { select: { classTemplateId: true } },
          },
        },
      },
    });
    const candidates: LegacyOwnershipCandidate[] = subs.map((s) => ({
      id: s.id,
      status: s.status,
      createdAt: s.createdAt,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      entitlementEndsAt: s.entitlementEndsAt,
      membershipPlan: {
        classCredits: s.membershipPlan.classCredits,
        allClassesAccess: s.membershipPlan.allClassesAccess,
        allowedCategories: s.membershipPlan.allowedCategories as string[],
        allowedTemplateIds: s.membershipPlan.classTemplateAccess.map((a) => a.classTemplateId),
      },
    }));
    const planNameById = new Map(subs.map((s) => [s.id, s.membershipPlan.name]));

    const statusSql = Prisma.join(
      CREDIT_CONSUMING_BOOKING_STATUSES.map((st) => Prisma.sql`${st}::"BookingStatus"`),
    );
    const rows = await prisma.$queryRaw<
      Array<{
        class_id: string;
        starts_at: Date;
        class_template_id: string;
        category: string | null;
        src: string;
        subscription_id: string | null;
      }>
    >`
      SELECT sc.id AS class_id, sc.starts_at, sc.class_template_id, ct.category::text AS category,
             'booking' AS src, b.subscription_id
      FROM bookings b
      INNER JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
      INNER JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE b.studio_id = ${m.studioId} AND b.user_id = ${m.userId}
        AND b.status IN (${statusSql})
      UNION ALL
      SELECT sc.id AS class_id, sc.starts_at, sc.class_template_id, ct.category::text AS category,
             'attendance' AS src, a.subscription_id
      FROM attendances a
      INNER JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
      INNER JOIN class_templates ct ON ct.id = sc.class_template_id
      WHERE a.studio_id = ${m.studioId} AND a.user_id = ${m.userId}
    `;
    const legs: ConsumptionLegRow[] = rows.map((r) => ({
      classId: r.class_id,
      startsAt: r.starts_at,
      classTemplateId: r.class_template_id,
      templateCategory: r.category,
      source: r.src === 'booking' ? 'booking' : 'attendance',
      subscriptionId: r.subscription_id,
    }));

    const { events, conflicts: memberConflicts } = collapseConsumptionRows(legs);
    const memberKey: MemberKey = `${m.studioId}:${m.userId}`;
    for (const c of memberConflicts) {
      conflicts.push({
        member: memberKey,
        classId: c.classId,
        booking: c.bookingSubscriptionId,
        attendance: c.attendanceSubscriptionId,
      });
    }

    const legacyEvents = events.filter((e) => e.attributedSubscriptionId === null);
    totalLegacyEvents += legacyEvents.length;

    for (const event of legacyEvents) {
      const covering = candidates.filter((c) => candidateWindowCovers(c, event.startsAt));
      if (covering.length > 1) {
        eventsInOverlappingWindows += 1;
        ambiguousBeforeTieBreak += 1;
        const owner = resolveLegacyEventOwner(event, candidates)!;
        ownerTally.set(owner, (ownerTally.get(owner) ?? 0) + 1);
        console.log(
          `  AMBIGUOUS→RESOLVED member=${memberKey} class=${event.classId} ` +
            `start=${event.startsAt.toISOString()} candidates=${covering.length} ` +
            `owner=${owner} (${planNameById.get(owner) ?? '?'})`,
        );
      } else if (covering.length === 0) {
        unowned += 1;
      } else {
        const owner = resolveLegacyEventOwner(event, candidates)!;
        ownerTally.set(owner, (ownerTally.get(owner) ?? 0) + 1);
      }
    }
  }

  console.log('\n--- SUMMARY ---');
  console.log(`Legacy NULL consumption events across multi-subscription members: ${totalLegacyEvents}`);
  console.log(`  in OVERLAPPING candidate windows (old SQL double-counted these): ${eventsInOverlappingWindows}`);
  console.log(`  ambiguous before tie-break (deterministically resolved by code): ${ambiguousBeforeTieBreak}`);
  console.log(`  with ZERO covering candidates (contribute to no ledger): ${unowned}`);
  console.log(`Explicit-attribution conflicts (booking vs attendance disagree): ${conflicts.length}`);
  for (const c of conflicts) {
    console.log(`  CONFLICT member=${c.member} class=${c.classId} booking=${c.booking} attendance=${c.attendance}`);
  }

  if (conflicts.length > 0) {
    console.log('\nRESULT: FAIL — explicit-attribution conflicts present (investigate before flag-ON).');
    return 1;
  }
  console.log('\nRESULT: PASS — no explicit-attribution conflicts. Legacy NULL events are');
  console.log('deterministically owned by the MM-5.1 code invariant; no date-based waiting needed.');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('DIAGNOSTIC ERROR:', err);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
