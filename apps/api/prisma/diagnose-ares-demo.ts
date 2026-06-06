/**
 * ARES Fitness — demo cleanup diagnostic.
 *
 * READ-ONLY. Zero writes. Safe to run against production at any time.
 * Only .findFirst, .findUniqueOrThrow, and .count are called — never
 * create / update / delete / upsert.
 *
 * Inspects legacy demo class templates, membership plans, and staff that
 * survive from a prior seed iteration and classifies each entity for the
 * cleanup plan.
 *
 * Classifications:
 *   SAFE_TO_DELETE      — no dependent rows; hard delete is safe
 *   SAFE_TO_SOFT_DELETE — historical data exists; set deleted_at instead
 *   REQUIRES_MIGRATION  — active or future refs that need resolution first
 *   DO_NOT_DELETE       — real Stripe subscriptions/payments; do not touch
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." pnpm --filter api diagnose:ares-demo
 */

import { PrismaClient, SubscriptionStatus } from '@prisma/client';

const prisma = new PrismaClient();

const ARES_SLUG = 'ares-fitness';

const DEMO_TEMPLATE_NAMES = [
  'Power Hour',
  'MetCon Small Group',
  'Mobility & Breath',
] as const;

const DEMO_PLAN_NAMES = ['Unlimited Strength', 'Flex 8', 'TURBO'] as const;

const DEMO_STAFF_DEFS = [
  { firstName: 'Riley',  lastName: 'Chen'    },
  { firstName: 'Jordan', lastName: 'Reyes'   },
  { firstName: 'Sam',    lastName: 'Okonkwo' },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type Classification =
  | 'SAFE_TO_DELETE'
  | 'SAFE_TO_SOFT_DELETE'
  | 'REQUIRES_MIGRATION'
  | 'DO_NOT_DELETE';

interface TemplateDiagnosis {
  found: boolean;
  id: string | null;
  name: string;
  totalScheduledClasses: number;
  futureScheduledClasses: number;
  pastScheduledClasses: number;
  totalBookings: number;
  confirmedBookings: number;
  attendanceRecords: number;
  waitlistEntries: number;
  classification: Classification;
}

interface PlanDiagnosis {
  found: boolean;
  id: string | null;
  name: string;
  active: boolean;
  priceCents: number;
  totalSubscriptions: number;
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  realStripeSubscriptions: number;
  totalPayments: number;
  realStripePayments: number;
  classification: Classification;
}

interface StaffDiagnosis {
  found: boolean;
  userId: string | null;
  name: string;
  email: string | null;
  hasMembership: boolean;
  futureClassesAsInstructor: number;
  pastClassesAsInstructor: number;
  attendanceOnTheirClasses: number;
  bookingsAsUser: number;
  subscriptionsAsUser: number;
  paymentsAsUser: number;
  classification: Classification;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

const CLASS_TAGS: Record<Classification, string> = {
  SAFE_TO_DELETE:      '[ SAFE_TO_DELETE      ]',
  SAFE_TO_SOFT_DELETE: '[ SAFE_TO_SOFT_DELETE ]',
  REQUIRES_MIGRATION:  '[ REQUIRES_MIGRATION  ]',
  DO_NOT_DELETE:       '[ DO_NOT_DELETE       ]',
};

function section(title: string): void {
  const fill = '─'.repeat(Math.max(2, 64 - title.length - 4));
  console.log(`\n── ${title} ${fill}`);
}

function entityHeader(name: string, id: string | null): void {
  const suffix = id ? `  (id: ${id})` : '  [NOT FOUND IN DB]';
  console.log(`\n  ${name}${suffix}`);
  console.log(`  ${'─'.repeat(name.length + suffix.length)}`);
}

function row(label: string, value: string | number, flagIfNonZero = false): void {
  const flag = flagIfNonZero && typeof value === 'number' && value > 0 ? ' !!' : '   ';
  console.log(`  ${flag} ${label.padEnd(36)} ${value}`);
}

// ─── ClassTemplate ────────────────────────────────────────────────────────────

async function diagnoseTemplate(
  studioId: string,
  name: string,
): Promise<TemplateDiagnosis> {
  const now = new Date();

  const template = await prisma.classTemplate.findFirst({
    where: { studioId, name, deletedAt: null },
    select: { id: true },
  });

  if (!template) {
    return {
      found: false, id: null, name,
      totalScheduledClasses: 0, futureScheduledClasses: 0, pastScheduledClasses: 0,
      totalBookings: 0, confirmedBookings: 0, attendanceRecords: 0, waitlistEntries: 0,
      classification: 'SAFE_TO_DELETE',
    };
  }

  const [
    totalScheduledClasses,
    futureScheduledClasses,
    totalBookings,
    confirmedBookings,
    attendanceRecords,
    waitlistEntries,
  ] = await Promise.all([
    prisma.scheduledClass.count({
      where: { classTemplateId: template.id },
    }),
    prisma.scheduledClass.count({
      where: { classTemplateId: template.id, startsAt: { gt: now } },
    }),
    prisma.booking.count({
      where: { scheduledClass: { classTemplateId: template.id } },
    }),
    prisma.booking.count({
      where: { scheduledClass: { classTemplateId: template.id }, status: 'CONFIRMED' },
    }),
    prisma.attendance.count({
      where: { scheduledClass: { classTemplateId: template.id } },
    }),
    prisma.waitlistEntry.count({
      where: { scheduledClass: { classTemplateId: template.id } },
    }),
  ]);

  const pastScheduledClasses = totalScheduledClasses - futureScheduledClasses;

  let classification: Classification;
  if (totalScheduledClasses === 0) {
    classification = 'SAFE_TO_DELETE';
  } else if (futureScheduledClasses > 0 && confirmedBookings > 0) {
    // Active future bookings — cannot touch
    classification = 'DO_NOT_DELETE';
  } else if (futureScheduledClasses > 0) {
    // Future classes exist but no confirmed bookings — reassign or cancel first
    classification = 'REQUIRES_MIGRATION';
  } else if (attendanceRecords > 0 || totalBookings > 0) {
    // Past classes only, historical member activity — soft-delete preserves history
    classification = 'SAFE_TO_SOFT_DELETE';
  } else {
    // Past classes only, zero member activity — safe to hard delete
    classification = 'SAFE_TO_DELETE';
  }

  return {
    found: true,
    id: template.id,
    name,
    totalScheduledClasses,
    futureScheduledClasses,
    pastScheduledClasses,
    totalBookings,
    confirmedBookings,
    attendanceRecords,
    waitlistEntries,
    classification,
  };
}

// ─── MembershipPlan ───────────────────────────────────────────────────────────

async function diagnosePlan(studioId: string, name: string): Promise<PlanDiagnosis> {
  const plan = await prisma.membershipPlan.findFirst({
    where: { studioId, name, deletedAt: null },
    select: { id: true, active: true, priceCents: true },
  });

  if (!plan) {
    return {
      found: false, id: null, name, active: false, priceCents: 0,
      totalSubscriptions: 0, activeSubscriptions: 0, pastDueSubscriptions: 0,
      canceledSubscriptions: 0, realStripeSubscriptions: 0,
      totalPayments: 0, realStripePayments: 0,
      classification: 'SAFE_TO_DELETE',
    };
  }

  const [
    totalSubscriptions,
    activeSubscriptions,
    pastDueSubscriptions,
    canceledSubscriptions,
    realStripeSubscriptions,
    totalPayments,
    realStripePayments,
  ] = await Promise.all([
    prisma.subscription.count({ where: { membershipPlanId: plan.id } }),
    prisma.subscription.count({
      where: { membershipPlanId: plan.id, status: SubscriptionStatus.ACTIVE },
    }),
    prisma.subscription.count({
      where: { membershipPlanId: plan.id, status: SubscriptionStatus.PAST_DUE },
    }),
    prisma.subscription.count({
      where: { membershipPlanId: plan.id, status: SubscriptionStatus.CANCELED },
    }),
    // Real Stripe subscription = ID present AND not a seeded demo placeholder
    prisma.subscription.count({
      where: {
        membershipPlanId: plan.id,
        stripeSubscriptionId: { not: null },
        NOT: { stripeSubscriptionId: { startsWith: 'sub_demo_' } },
      },
    }),
    prisma.payment.count({ where: { membershipPlanId: plan.id } }),
    // Real Stripe payment = paymentIntentId present AND not a seeded demo placeholder
    prisma.payment.count({
      where: {
        membershipPlanId: plan.id,
        stripePaymentIntentId: { not: null },
        NOT: { stripePaymentIntentId: { startsWith: 'pi_demo_' } },
      },
    }),
  ]);

  let classification: Classification;
  if (realStripeSubscriptions > 0) {
    // Real members billed through Stripe — must not delete
    classification = 'DO_NOT_DELETE';
  } else if (activeSubscriptions > 0 || pastDueSubscriptions > 0) {
    // Non-real-Stripe but active/past-due subs exist — migrate before deleting
    classification = 'REQUIRES_MIGRATION';
  } else if (totalSubscriptions > 0) {
    // Canceled demo subs still reference the plan — must be removed first
    classification = 'REQUIRES_MIGRATION';
  } else {
    classification = 'SAFE_TO_DELETE';
  }

  return {
    found: true,
    id: plan.id,
    name,
    active: plan.active,
    priceCents: plan.priceCents,
    totalSubscriptions,
    activeSubscriptions,
    pastDueSubscriptions,
    canceledSubscriptions,
    realStripeSubscriptions,
    totalPayments,
    realStripePayments,
    classification,
  };
}

// ─── Staff (User + StudioStaffProfile) ───────────────────────────────────────

async function diagnoseStaff(
  studioId: string,
  firstName: string,
  lastName: string,
): Promise<StaffDiagnosis> {
  const now = new Date();
  const fullName = `${firstName} ${lastName}`;

  // Locate via StudioStaffProfile scoped to this studio
  const staffProfile = await prisma.studioStaffProfile.findFirst({
    where: { studioId, user: { firstName, lastName } },
    select: {
      userId: true,
      user: { select: { email: true } },
    },
  });

  if (!staffProfile) {
    return {
      found: false, userId: null, name: fullName, email: null,
      hasMembership: false,
      futureClassesAsInstructor: 0, pastClassesAsInstructor: 0,
      attendanceOnTheirClasses: 0,
      bookingsAsUser: 0, subscriptionsAsUser: 0, paymentsAsUser: 0,
      classification: 'SAFE_TO_DELETE',
    };
  }

  const { userId } = staffProfile;

  const [
    membershipCount,
    futureClassesAsInstructor,
    pastClassesAsInstructor,
    attendanceOnTheirClasses,
    bookingsAsUser,
    subscriptionsAsUser,
    paymentsAsUser,
  ] = await Promise.all([
    prisma.studioMembership.count({ where: { studioId, userId } }),
    // Future scheduled classes where this user is the instructor
    prisma.scheduledClass.count({
      where: { studioId, instructorId: userId, startsAt: { gt: now } },
    }),
    // Past scheduled classes where this user was the instructor
    prisma.scheduledClass.count({
      where: { studioId, instructorId: userId, startsAt: { lte: now } },
    }),
    // Attendance records on classes they instructed (historical data)
    prisma.attendance.count({
      where: { scheduledClass: { studioId, instructorId: userId } },
    }),
    // Bookings where the coach was themselves the booking user (unusual)
    prisma.booking.count({ where: { studioId, userId } }),
    // Subscriptions where the coach is the subscriber
    prisma.subscription.count({ where: { studioId, userId } }),
    // Payments where the coach is the payer
    prisma.payment.count({ where: { studioId, userId } }),
  ]);

  let classification: Classification;
  if (futureClassesAsInstructor > 0) {
    // Future classes still assigned — must reassign instructor_id first
    classification = 'REQUIRES_MIGRATION';
  } else if (bookingsAsUser > 0 || subscriptionsAsUser > 0 || paymentsAsUser > 0) {
    // User has member-side data (Booking/Subscription/Payment) — must resolve first
    classification = 'REQUIRES_MIGRATION';
  } else {
    // No future classes, no member data — safe to delete in order:
    // StudioStaffProfile → StudioMembership → User
    classification = 'SAFE_TO_DELETE';
  }

  return {
    found: true,
    userId,
    name: fullName,
    email: staffProfile.user.email,
    hasMembership: membershipCount > 0,
    futureClassesAsInstructor,
    pastClassesAsInstructor,
    attendanceOnTheirClasses,
    bookingsAsUser,
    subscriptionsAsUser,
    paymentsAsUser,
    classification,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date();

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  ARES DEMO CLEANUP DIAGNOSTIC  (READ-ONLY)');
  console.log(`  Studio : ${ARES_SLUG}`);
  console.log(`  Run at : ${now.toISOString()}`);
  console.log('════════════════════════════════════════════════════════════════');

  const studio = await prisma.studio.findUniqueOrThrow({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true },
  });
  console.log(`  DB id  : ${studio.id}  (${studio.name})`);

  // ── Class templates ──────────────────────────────────────────────────────

  section('CLASS TEMPLATES');
  const templateResults: TemplateDiagnosis[] = [];

  for (const name of DEMO_TEMPLATE_NAMES) {
    const d = await diagnoseTemplate(studio.id, name);
    templateResults.push(d);

    entityHeader(d.name, d.id);
    if (!d.found) {
      row('Status', 'NOT FOUND — already removed or never seeded');
      row('Classification', CLASS_TAGS[d.classification]);
      continue;
    }
    row('Scheduled classes (total)',  d.totalScheduledClasses);
    row('  future',                   d.futureScheduledClasses,  true);
    row('  past',                     d.pastScheduledClasses);
    row('Bookings (total)',            d.totalBookings);
    row('  confirmed',                d.confirmedBookings,       true);
    row('Attendance records',          d.attendanceRecords);
    row('Waitlist entries',            d.waitlistEntries,         true);
    row('Classification',             CLASS_TAGS[d.classification]);
  }

  // ── Membership plans ─────────────────────────────────────────────────────

  section('MEMBERSHIP PLANS');
  const planResults: PlanDiagnosis[] = [];

  for (const name of DEMO_PLAN_NAMES) {
    const d = await diagnosePlan(studio.id, name);
    planResults.push(d);

    entityHeader(d.name, d.id);
    if (!d.found) {
      row('Status', 'NOT FOUND — already removed or never seeded');
      row('Classification', CLASS_TAGS[d.classification]);
      continue;
    }
    row('Active',                      d.active ? 'yes' : 'no');
    row('Price',                       `${(d.priceCents / 100).toFixed(2)} MXN`);
    row('Subscriptions (total)',        d.totalSubscriptions);
    row('  ACTIVE',                    d.activeSubscriptions,      true);
    row('  PAST_DUE',                  d.pastDueSubscriptions,     true);
    row('  CANCELED',                  d.canceledSubscriptions);
    row('  real Stripe subs (!)',       d.realStripeSubscriptions,  true);
    row('Payments (total)',             d.totalPayments);
    row('  real Stripe payments (!)',   d.realStripePayments,       true);
    row('Classification',             CLASS_TAGS[d.classification]);
  }

  // ── Demo staff ───────────────────────────────────────────────────────────

  section('DEMO STAFF');
  const staffResults: StaffDiagnosis[] = [];

  for (const def of DEMO_STAFF_DEFS) {
    const d = await diagnoseStaff(studio.id, def.firstName, def.lastName);
    staffResults.push(d);

    entityHeader(d.name, d.userId);
    if (!d.found) {
      row('Status', 'NOT FOUND — already removed or never seeded');
      row('Classification', CLASS_TAGS[d.classification]);
      continue;
    }
    row('Email',                           d.email ?? '(none)');
    row('Has studio membership',           d.hasMembership ? 'yes' : 'no');
    row('Future classes as instructor (!)', d.futureClassesAsInstructor, true);
    row('Past classes as instructor',      d.pastClassesAsInstructor);
    row('Attendance on their classes',     d.attendanceOnTheirClasses);
    row('Bookings as user (member) (!)',   d.bookingsAsUser,            true);
    row('Subscriptions as user (!)',       d.subscriptionsAsUser,       true);
    row('Payments as user (!)',            d.paymentsAsUser,            true);
    row('Classification',                CLASS_TAGS[d.classification]);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');

  type SummaryRow = { type: string; name: string; classification: Classification; found: boolean };
  const all: SummaryRow[] = [
    ...templateResults.map((r) => ({ type: 'ClassTemplate ', name: r.name, classification: r.classification, found: r.found })),
    ...planResults.map((r)    => ({ type: 'MembershipPlan', name: r.name, classification: r.classification, found: r.found })),
    ...staffResults.map((r)   => ({ type: 'Staff/User    ', name: r.name, classification: r.classification, found: r.found })),
  ];

  const counts: Record<Classification, number> = {
    SAFE_TO_DELETE: 0, SAFE_TO_SOFT_DELETE: 0,
    REQUIRES_MIGRATION: 0, DO_NOT_DELETE: 0,
  };

  console.log('');
  for (const r of all) {
    counts[r.classification]++;
    const notFound = r.found ? '' : '  [not found]';
    console.log(`  ${CLASS_TAGS[r.classification]}  [${r.type}]  ${r.name}${notFound}`);
  }

  console.log('');
  console.log(`  SAFE_TO_DELETE      : ${counts.SAFE_TO_DELETE}`);
  console.log(`  SAFE_TO_SOFT_DELETE : ${counts.SAFE_TO_SOFT_DELETE}`);
  console.log(`  REQUIRES_MIGRATION  : ${counts.REQUIRES_MIGRATION}`);
  console.log(`  DO_NOT_DELETE       : ${counts.DO_NOT_DELETE}`);

  const actionRequired = counts.DO_NOT_DELETE > 0 || counts.REQUIRES_MIGRATION > 0;

  console.log('');
  if (actionRequired) {
    console.log('  ACTION REQUIRED — resolve migrations / blockers before cleanup.');
    if (counts.DO_NOT_DELETE > 0) {
      console.log('  !! Real Stripe subscriptions detected. Do not delete those plans.');
    }
    if (counts.REQUIRES_MIGRATION > 0) {
      console.log('  !! Future classes or active subscriptions need migration first.');
    }
  } else {
    console.log('  All entities clear. Proceed with cleanup script.');
  }

  // ── JSON output ───────────────────────────────────────────────────────────

  console.log('');
  section('JSON SUMMARY');
  console.log(
    JSON.stringify(
      {
        event: 'diagnose_ares_demo',
        studio: ARES_SLUG,
        runAt: now.toISOString(),
        classTemplates: templateResults,
        membershipPlans: planResults,
        staff: staffResults,
        summary: counts,
        actionRequired,
      },
      null,
      2,
    ),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
