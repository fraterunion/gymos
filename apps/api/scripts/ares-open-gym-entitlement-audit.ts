/**
 * READ-ONLY audit: who can use Open Gym at ARES today, and through which mechanism?
 *
 * Open Gym is reachable two ways, and both must agree with the plan's saved entitlement:
 *   1. Door access      — MembershipPlan.openGymAccess (+ window), evaluated on a wallet scan
 *                         with no applicable reservation (CheckInType.OPEN_GYM).
 *   2. Scheduled slots  — ClassTemplate.isOpenGymSlot classes, bookable/check-in-able like any
 *                         class. Before the entitlement fix these were authorized by class
 *                         access alone (allClassesAccess / template list), ignoring
 *                         openGymAccess.
 *
 * Usage (production vars via Railway, no writes):
 *   railway run --service api npx tsx scripts/ares-open-gym-entitlement-audit.ts
 *
 * Every statement is a SELECT. Output is aggregate-only: plan/template/class ids, counts and
 * subscription ids. It never prints emails, names, phones or userIds.
 */
import { PrismaClient } from '@prisma/client';
import { currentlyEntitledSubscriptionWhere } from '../src/memberships/membership-entitlement';

const STUDIO_SLUG = process.env.ARES_STUDIO_SLUG ?? 'ares-fitness';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const now = new Date();
  try {
    const studio = await prisma.studio.findFirst({
      where: { slug: STUDIO_SLUG, deletedAt: null },
      select: { id: true, timezone: true },
    });
    if (!studio) throw new Error(`Studio not found: ${STUDIO_SLUG}`);
    console.log(`studio ${studio.id} tz=${studio.timezone} now=${now.toISOString()}`);

    const plans = await prisma.membershipPlan.findMany({
      where: { studioId: studio.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        active: true,
        deletedAt: true,
        priceCents: true,
        classCredits: true,
        allClassesAccess: true,
        allowedCategories: true,
        openGymAccess: true,
        openGymWindowStart: true,
        openGymWindowEnd: true,
        exclusiveGroup: true,
        updatedAt: true,
        classTemplateAccess: {
          select: { classTemplate: { select: { id: true, name: true, isOpenGymSlot: true } } },
        },
      },
    });

    const templates = await prisma.classTemplate.findMany({
      where: { studioId: studio.id },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        isOpenGymSlot: true,
        category: true,
        accessWindowStart: true,
        accessWindowEnd: true,
      },
    });
    const ogTemplates = templates.filter((t) => t.isOpenGymSlot);
    const ogTemplateIds = new Set(ogTemplates.map((t) => t.id));

    console.log('\n== Membership plans ==');
    for (const p of plans) {
      const explicitOg = p.classTemplateAccess.filter((a) => a.classTemplate.isOpenGymSlot);
      const slotAccess = p.allClassesAccess
        ? 'ALL_CLASSES (includes every Open Gym slot)'
        : explicitOg.length > 0
          ? `explicit: ${explicitOg.map((a) => `${a.classTemplate.name}[${a.classTemplate.id}]`).join(', ')}`
          : p.allowedCategories.length > 0
            ? `categories: ${p.allowedCategories.join(',')}`
            : 'none';
      console.log(
        JSON.stringify({
          id: p.id,
          name: p.name,
          active: p.active,
          deleted: p.deletedAt !== null,
          priceCents: p.priceCents,
          classCredits: p.classCredits,
          exclusiveGroup: p.exclusiveGroup,
          openGymAccess: p.openGymAccess,
          openGymWindow:
            p.openGymWindowStart && p.openGymWindowEnd
              ? `${p.openGymWindowStart}-${p.openGymWindowEnd}`
              : null,
          allClassesAccess: p.allClassesAccess,
          explicitTemplateCount: p.classTemplateAccess.length,
          openGymSlotBookingAccessPreFix: slotAccess,
          updatedAt: p.updatedAt.toISOString(),
        }),
      );
    }

    console.log('\n== Open Gym slot templates (isOpenGymSlot=true) ==');
    if (ogTemplates.length === 0) console.log('  none');
    for (const t of ogTemplates) {
      console.log(
        JSON.stringify({
          id: t.id,
          name: t.name,
          deleted: t.deletedAt !== null,
          category: t.category,
          accessWindow:
            t.accessWindowStart && t.accessWindowEnd
              ? `${t.accessWindowStart}-${t.accessWindowEnd}`
              : null,
        }),
      );
    }

    const dayPassOg = await prisma.dayPassClassAccess.findMany({
      where: { studioId: studio.id, classTemplateId: { in: [...ogTemplateIds] } },
      select: { classTemplateId: true },
    });
    console.log(`Day Pass allowlist rows on Open Gym templates: ${dayPassOg.length}`);

    // ── Currently entitled subscriptions per plan ────────────────────────────────────────
    const entitled = await prisma.subscription.findMany({
      where: {
        studioId: studio.id,
        ...currentlyEntitledSubscriptionWhere(now),
      },
      select: { id: true, userId: true, membershipPlanId: true },
    });
    const byPlan = new Map<string, Set<string>>();
    for (const s of entitled) {
      const set = byPlan.get(s.membershipPlanId) ?? new Set<string>();
      set.add(s.userId);
      byPlan.set(s.membershipPlanId, set);
    }
    const userPlans = new Map<string, Set<string>>();
    for (const s of entitled) {
      const set = userPlans.get(s.userId) ?? new Set<string>();
      set.add(s.membershipPlanId);
      userPlans.set(s.userId, set);
    }
    const planById = new Map(plans.map((p) => [p.id, p]));

    console.log('\n== Currently entitled members per plan (currentlyEntitledSubscriptionWhere) ==');
    for (const p of plans) {
      const n = byPlan.get(p.id)?.size ?? 0;
      if (n > 0) console.log(`  ${p.name} [${p.id}]: ${n} members`);
    }
    const doorAllowedUsers = [...userPlans.entries()].filter(([, ids]) =>
      [...ids].some((id) => planById.get(id)?.openGymAccess),
    );
    const fullAccessOnlyWouldAllow = [...userPlans.entries()].filter(([, ids]) =>
      [...ids].some((id) => planById.get(id)?.name === 'Full Access'),
    );
    console.log(`Members door-eligible TODAY (any entitled plan with openGymAccess): ${doorAllowedUsers.length}`);
    console.log(`Members door-eligible after target config (Full Access only):       ${fullAccessOnlyWouldAllow.length}`);
    const multi = [...userPlans.values()].filter((s) => s.size > 1).length;
    console.log(`Members with >1 entitled subscription: ${multi}`);

    // ── Open Gym usage history (never modified by this fix) ──────────────────────────────
    const ogVisits = await prisma.attendance.count({ where: { studioId: studio.id, type: 'OPEN_GYM' } });
    const ogVisits30d = await prisma.attendance.count({
      where: {
        studioId: studio.id,
        type: 'OPEN_GYM',
        checkedInAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
      },
    });
    console.log(`\nOPEN_GYM door attendances: total=${ogVisits} last30d=${ogVisits30d}`);

    // Door visits in last 30d by members who are entitled ONLY under non-Full-Access plans now.
    const recentOg = await prisma.attendance.findMany({
      where: {
        studioId: studio.id,
        type: 'OPEN_GYM',
        checkedInAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
      },
      select: { userId: true },
    });
    const recentOgByCurrentPlan = new Map<string, number>();
    for (const a of recentOg) {
      const ids = [...(userPlans.get(a.userId) ?? [])];
      const label = ids.length === 0 ? '(no current entitlement)' : ids.map((id) => planById.get(id)?.name ?? id).sort().join(' + ');
      recentOgByCurrentPlan.set(label, (recentOgByCurrentPlan.get(label) ?? 0) + 1);
    }
    console.log('Last-30d OPEN_GYM door visits grouped by member\'s CURRENT entitled plan(s):');
    for (const [label, n] of recentOgByCurrentPlan) console.log(`  ${label}: ${n}`);

    if (ogTemplateIds.size > 0) {
      const ogClassAttend = await prisma.attendance.count({
        where: { studioId: studio.id, type: 'CLASS', scheduledClass: { classTemplateId: { in: [...ogTemplateIds] } } },
      });
      console.log(`CLASS attendances on Open Gym slot classes (history): ${ogClassAttend}`);

      // ── Future Open Gym slot classes and the reservations on them ──────────────────────
      const futureClasses = await prisma.scheduledClass.findMany({
        where: {
          studioId: studio.id,
          classTemplateId: { in: [...ogTemplateIds] },
          startsAt: { gte: now },
          status: 'SCHEDULED',
        },
        select: { id: true, startsAt: true },
        orderBy: { startsAt: 'asc' },
      });
      console.log(`\nFuture SCHEDULED Open Gym slot classes: ${futureClasses.length}` +
        (futureClasses.length ? ` (first ${futureClasses[0]!.startsAt.toISOString()}, last ${futureClasses[futureClasses.length - 1]!.startsAt.toISOString()})` : ''));

      const futureBookings = await prisma.booking.findMany({
        where: {
          studioId: studio.id,
          status: 'CONFIRMED',
          scheduledClassId: { in: futureClasses.map((c) => c.id) },
        },
        select: { id: true, userId: true, subscriptionId: true, scheduledClassId: true },
      });
      const futureWaitlist = await prisma.waitlistEntry.count({
        where: {
          studioId: studio.id,
          status: 'WAITING',
          scheduledClassId: { in: futureClasses.map((c) => c.id) },
        },
      });
      console.log(`Future CONFIRMED bookings on Open Gym slots: ${futureBookings.length}; WAITING waitlist: ${futureWaitlist}`);
      let unauthorizedAfterFix = 0;
      for (const b of futureBookings) {
        const ids = [...(userPlans.get(b.userId) ?? [])];
        const authorized = ids.some((id) => planById.get(id)?.openGymAccess && planById.get(id)?.name === 'Full Access');
        if (!authorized) {
          unauthorizedAfterFix += 1;
          console.log(
            `  WOULD-BE-UNAUTHORIZED booking=${b.id} class=${b.scheduledClassId} sub=${b.subscriptionId ?? 'null'} plans=${ids.map((id) => planById.get(id)?.name ?? id).join('+') || '(none)'}`,
          );
        }
      }
      console.log(`Future Open Gym slot bookings not covered by Full Access entitlement: ${unauthorizedAfterFix}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
