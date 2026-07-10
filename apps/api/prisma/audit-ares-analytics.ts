/**
 * ARES Analytics — production data contamination audit (READ-ONLY).
 *
 * Zero writes. SELECT / aggregate only.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." pnpm --filter api audit:ares-analytics
 *
 * Classifies demo/seed/review vs real records and quantifies impact on
 * visible Analytics KPIs. Does not print secrets or full Stripe credentials.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ARES_SLUG = 'ares-fitness';
const ARES_TZ = 'America/Mexico_City';

// ─── Classification constants (from seed / cleanup / review scripts) ─────────

/** Real ARES coaches — @ares.demo is production identity, not demo contamination. */
const REAL_COACH_EMAILS = new Set([
  'yayo@ares.demo',
  'coco@ares.demo',
  'karen@ares.demo',
  'fer@ares.demo',
  'estefy@ares.demo',
  'mau@ares.demo',
]);

const DEMO_MEMBER_EMAILS = new Set([
  'member1@ares.demo',
  'member2@ares.demo',
  'member3@ares.demo',
]);

const DEMO_STAFF_EMAILS = new Set([
  'admin@ares.demo',
  'staff@ares.demo',
  'instructor@ares.demo',
]);

const REVIEW_EMAILS = new Set([
  'apple.review@fraterunion.com',
  'staff.review@fraterunion.com',
]);

const LEGACY_DEMO_TEMPLATE_NAMES = new Set([
  'Power Hour',
  'MetCon Small Group',
  'Mobility & Breath',
]);

const LEGACY_DEMO_PLAN_NAMES = new Set([
  'Unlimited Strength',
  'Flex 8',
  'TURBO',
]);

const LEGACY_DEMO_STAFF_NAMES = new Set([
  'Riley Chen',
  'Jordan Reyes',
  'Sam Okonkwo',
]);

type RecordClass =
  | 'REAL_PRODUCTION'
  | 'REQUIRED_REVIEW_ACCOUNT'
  | 'DEMO_SEED'
  | 'UNKNOWN_NEEDS_HUMAN';

function classifyUserEmail(email: string): RecordClass {
  const e = email.toLowerCase();
  if (REVIEW_EMAILS.has(e)) return 'REQUIRED_REVIEW_ACCOUNT';
  if (REAL_COACH_EMAILS.has(e)) return 'REAL_PRODUCTION';
  if (DEMO_MEMBER_EMAILS.has(e) || DEMO_STAFF_EMAILS.has(e)) return 'DEMO_SEED';
  if (e.endsWith('@pilates.demo') || e.endsWith('@gymos.local')) return 'DEMO_SEED';
  if (e.endsWith('@ares.demo')) return 'UNKNOWN_NEEDS_HUMAN';
  return 'REAL_PRODUCTION';
}

function isDemoStripeId(value: string | null): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return (
    v.includes('demo') ||
    v.startsWith('pi_demo_') ||
    v.startsWith('in_demo_') ||
    v.startsWith('cus_demo_') ||
    v.startsWith('sub_demo_') ||
    v.startsWith('sub_review_')
  );
}

/** Records that should be excluded from owner-facing analytics totals. */
function shouldExcludeFromAnalytics(params: {
  userEmail: string;
  stripePaymentIntentId: string | null;
  stripeInvoiceId: string | null;
  templateName?: string | null;
}): { exclude: boolean; reason: string; classification: RecordClass } {
  const userClass = classifyUserEmail(params.userEmail);
  if (userClass === 'DEMO_SEED') {
    return { exclude: true, reason: `demo user ${params.userEmail}`, classification: userClass };
  }
  if (userClass === 'REQUIRED_REVIEW_ACCOUNT') {
    return {
      exclude: true,
      reason: `review account ${params.userEmail}`,
      classification: userClass,
    };
  }
  if (
    isDemoStripeId(params.stripePaymentIntentId) ||
    isDemoStripeId(params.stripeInvoiceId)
  ) {
    return { exclude: true, reason: 'demo Stripe payment id', classification: 'DEMO_SEED' };
  }
  if (params.templateName && LEGACY_DEMO_TEMPLATE_NAMES.has(params.templateName)) {
    return { exclude: true, reason: `legacy demo template ${params.templateName}`, classification: 'DEMO_SEED' };
  }
  if (userClass === 'UNKNOWN_NEEDS_HUMAN') {
    return { exclude: false, reason: 'unknown @ares.demo — counted in production', classification: userClass };
  }
  return { exclude: false, reason: 'production', classification: 'REAL_PRODUCTION' };
}

function formatMoney(cents: number, currency = 'mxn'): string {
  return `$${(cents / 100).toLocaleString('es-MX', { maximumFractionDigits: 0 })} ${currency.toUpperCase()}`;
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);
}

function metricRow(
  label: string,
  current: number,
  withoutDemo: number,
  unit: 'money' | 'count',
  currency = 'mxn',
): void {
  const diff = current - withoutDemo;
  const fmt = (n: number) =>
    unit === 'money' ? formatMoney(n, currency) : String(n);
  console.log(`\n  ${label}`);
  console.log(`    Actual (todo incluido)     : ${fmt(current)}`);
  console.log(`    Sin demo/review/seed     : ${fmt(withoutDemo)}`);
  console.log(`    Diferencia               : ${fmt(diff)}`);
}

// ─── Period helpers ───────────────────────────────────────────────────────────

function monthWindow(now: Date, timezone: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const utcMidnight = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const offsetParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(utcMidnight);
  const gp = (t: string) => Number(offsetParts.find((p) => p.type === t)?.value ?? '0');
  const offsetMs =
    Date.UTC(gp('year'), gp('month') - 1, gp('day'), gp('hour'), gp('minute'), gp('second')) -
    utcMidnight.getTime();
  const start = new Date(utcMidnight.getTime() - offsetMs);
  return { start, end: now };
}

function rollingDays(days: number, now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - days * 86_400_000), end: now };
}

// ─── Main audit ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set. Set it to run this read-only audit against a database.',
    );
    process.exit(1);
  }

  const now = new Date();

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ARES ANALYTICS DATA AUDIT  (READ-ONLY — no writes)');
  console.log(`  Studio slug : ${ARES_SLUG}`);
  console.log(`  Run at      : ${now.toISOString()}`);
  console.log('══════════════════════════════════════════════════════════════');

  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true, timezone: true },
  });

  if (!studio) {
    throw new Error(`Studio not found: ${ARES_SLUG}`);
  }

  const tz = studio.timezone || ARES_TZ;
  const studioId = studio.id;

  console.log(`  Studio id   : ${studioId}`);
  console.log(`  Studio name : ${studio.name}`);
  console.log(`  Timezone    : ${tz}`);

  const month = monthWindow(now, tz);
  const days30 = rollingDays(30, now);
  const days7 = rollingDays(7, now);
  const days90 = rollingDays(90, now);

  // ── A. Users / memberships ────────────────────────────────────────────────

  section('A. USERS & STUDIO MEMBERSHIPS');

  const memberships = await prisma.studioMembership.findMany({
    where: { studioId },
    select: {
      id: true,
      role: true,
      deletedAt: true,
      createdAt: true,
      user: { select: { id: true, email: true, firstName: true, lastName: true, deletedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const classCounts: Record<RecordClass, number> = {
    REAL_PRODUCTION: 0,
    REQUIRED_REVIEW_ACCOUNT: 0,
    DEMO_SEED: 0,
    UNKNOWN_NEEDS_HUMAN: 0,
  };

  for (const m of memberships) {
    const email = m.user.email;
    const cls = classifyUserEmail(email);
    classCounts[cls]++;
    const deleted = m.deletedAt || m.user.deletedAt ? ' [deleted]' : '';
    console.log(
      `  [${cls.padEnd(22)}] ${m.role.padEnd(12)} ${email}${deleted}`,
    );
  }

  console.log('\n  Totals by classification:');
  for (const [k, v] of Object.entries(classCounts)) {
    console.log(`    ${k}: ${v}`);
  }

  // ── B. Payments ───────────────────────────────────────────────────────────

  section('B. PAYMENTS (all statuses)');

  const payments = await prisma.payment.findMany({
    where: { studioId },
    select: {
      id: true,
      amountCents: true,
      currency: true,
      status: true,
      paymentMethod: true,
      paidAt: true,
      createdAt: true,
      stripePaymentIntentId: true,
      stripeInvoiceId: true,
      user: { select: { email: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const contaminatingPayments: typeof payments = [];

  for (const p of payments) {
    const { exclude, reason, classification } = shouldExcludeFromAnalytics({
      userEmail: p.user.email,
      stripePaymentIntentId: p.stripePaymentIntentId,
      stripeInvoiceId: p.stripeInvoiceId,
    });
    const pi = p.stripePaymentIntentId
      ? p.stripePaymentIntentId.slice(0, 20) + (p.stripePaymentIntentId.length > 20 ? '…' : '')
      : '(none)';
    const flag = exclude ? '!!' : '  ';
    console.log(
      `${flag} ${p.status.padEnd(10)} ${formatMoney(p.amountCents, p.currency).padEnd(14)} ` +
        `${p.paymentMethod.padEnd(8)} ${p.user.email.padEnd(32)} pi:${pi} → ${classification} (${reason})`,
    );
    if (exclude) contaminatingPayments.push(p);
  }

  console.log(`\n  Total payments: ${payments.length}`);
  console.log(`  Contaminating (exclude from analytics): ${contaminatingPayments.length}`);

  // ── C. Scheduled classes ──────────────────────────────────────────────────

  section('C. SCHEDULED CLASSES');

  const [totalClasses, futureClasses, canceledClasses, pastClasses, unassignedInstructor] =
    await Promise.all([
      prisma.scheduledClass.count({ where: { studioId } }),
      prisma.scheduledClass.count({
        where: { studioId, startsAt: { gt: now }, status: { not: 'CANCELLED' } },
      }),
      prisma.scheduledClass.count({ where: { studioId, status: 'CANCELLED' } }),
      prisma.scheduledClass.count({
        where: { studioId, startsAt: { lte: now }, status: { not: 'CANCELLED' } },
      }),
      prisma.scheduledClass.count({
        where: { studioId, instructorId: null, status: { not: 'CANCELLED' } },
      }),
    ]);

  console.log(`  Total scheduled classes      : ${totalClasses}`);
  console.log(`  Future (non-canceled)        : ${futureClasses}`);
  console.log(`  Past (non-canceled)          : ${pastClasses}`);
  console.log(`  Canceled                     : ${canceledClasses}`);
  console.log(`  Without instructor           : ${unassignedInstructor}`);

  const legacyTemplateClasses = await prisma.scheduledClass.count({
    where: {
      studioId,
      classTemplate: { name: { in: [...LEGACY_DEMO_TEMPLATE_NAMES] } },
    },
  });
  console.log(`  On legacy demo templates     : ${legacyTemplateClasses}`);

  // Old vs new coach count methodology
  section('COACH COUNT — OLD vs NEW METHODOLOGY (30 days)');

  const oldCoachRows = await prisma.$queryRaw<
    { email: string; first_name: string; last_name: string; class_count: bigint; future_included: bigint }[]
  >`
    SELECT u.email, u.first_name, u.last_name,
           COUNT(sc.id)::bigint AS class_count,
           COUNT(sc.id) FILTER (WHERE sc.starts_at > ${now})::bigint AS future_included
    FROM users u
    JOIN scheduled_classes sc ON sc.instructor_id = u.id
    WHERE sc.studio_id = ${studioId}
      AND sc.starts_at >= ${days30.start}
      AND sc.status != 'CANCELLED'
    GROUP BY u.id, u.email, u.first_name, u.last_name
    ORDER BY class_count DESC
  `;

  const newCoachRows = await prisma.$queryRaw<
    { email: string; first_name: string; last_name: string; class_count: bigint }[]
  >`
    SELECT u.email, u.first_name, u.last_name,
           COUNT(DISTINCT sc.id)::bigint AS class_count
    FROM users u
    JOIN scheduled_classes sc ON sc.instructor_id = u.id
    WHERE sc.studio_id = ${studioId}
      AND sc.starts_at >= ${days30.start}
      AND sc.starts_at <= ${now}
      AND sc.status NOT IN ('CANCELLED')
    GROUP BY u.id, u.email, u.first_name, u.last_name
    ORDER BY class_count DESC
  `;

  console.log('\n  Per instructor (30d window):');
  console.log('  ' + 'Coach'.padEnd(28) + 'OLD count'.padEnd(12) + 'NEW count'.padEnd(12) + 'Future in OLD');
  const newMap = new Map(newCoachRows.map((r) => [r.email, Number(r.class_count)]));
  for (const r of oldCoachRows) {
    const oldC = Number(r.class_count);
    const newC = newMap.get(r.email) ?? 0;
    const future = Number(r.future_included);
    const marker = oldC >= 25 ? ' ← likely inflated' : '';
    console.log(
      `  ${(r.first_name + ' ' + r.last_name).padEnd(28)}${String(oldC).padEnd(12)}${String(newC).padEnd(12)}${future}${marker}`,
    );
  }

  if (oldCoachRows[0]) {
    const top = oldCoachRows[0];
    console.log('\n  Top coach inflation explanation:');
    console.log(`    Coach: ${top.first_name} ${top.last_name} (${top.email})`);
    console.log(`    OLD count (no upper bound): ${top.class_count}`);
    console.log(`    NEW count (past only, DISTINCT): ${newMap.get(top.email) ?? 0}`);
    console.log(`    Future classes counted in OLD: ${top.future_included}`);
  }

  for (const d of [7, 30, 90] as const) {
    const win = rollingDays(d, now);
    const rows = await prisma.$queryRaw<
      { email: string; first_name: string; last_name: string; class_count: bigint }[]
    >`
      SELECT u.email, u.first_name, u.last_name,
             COUNT(DISTINCT sc.id)::bigint AS class_count
      FROM users u
      JOIN scheduled_classes sc ON sc.instructor_id = u.id
      WHERE sc.studio_id = ${studioId}
        AND sc.starts_at >= ${win.start}
        AND sc.starts_at <= ${now}
        AND sc.status NOT IN ('CANCELLED')
      GROUP BY u.id, u.email, u.first_name, u.last_name
      ORDER BY class_count DESC
    `;
    console.log(`\n  Corrected counts — last ${d} days (past only):`);
    for (const r of rows) {
      const cls = classifyUserEmail(r.email);
      console.log(
        `    ${r.first_name} ${r.last_name} (${r.email}) [${cls}]: ${r.class_count} clases`,
      );
    }
  }

  // ── D. Bookings / attendance ──────────────────────────────────────────────

  section('D. BOOKINGS & ATTENDANCE (30 days)');

  const demoUserIds = memberships
    .filter((m) => shouldExcludeFromAnalytics({
      userEmail: m.user.email,
      stripePaymentIntentId: null,
      stripeInvoiceId: null,
    }).exclude)
    .map((m) => m.user.id);

  const [bookingsAll, bookingsDemo, attendancesAll, attendancesDemo] = await Promise.all([
    prisma.booking.count({
      where: {
        studioId,
        createdAt: { gte: days30.start },
        status: { not: 'CANCELLED' },
      },
    }),
    demoUserIds.length > 0
      ? prisma.booking.count({
          where: {
            studioId,
            userId: { in: demoUserIds },
            createdAt: { gte: days30.start },
            status: { not: 'CANCELLED' },
          },
        })
      : Promise.resolve(0),
    prisma.attendance.count({
      where: { studioId, checkedInAt: { gte: days30.start } },
    }),
    demoUserIds.length > 0
      ? prisma.attendance.count({
          where: {
            studioId,
            userId: { in: demoUserIds },
            checkedInAt: { gte: days30.start },
          },
        })
      : Promise.resolve(0),
  ]);

  console.log(`  Bookings (30d)           all: ${bookingsAll}  demo/review users: ${bookingsDemo}`);
  console.log(`  Attendances (30d)        all: ${attendancesAll}  demo/review users: ${attendancesDemo}`);

  // ── 2. Metric impact (financial month + ops 30d) ───────────────────────────

  section('METRIC IMPACT — FINANCIAL (current month, studio TZ)');

  const succeededMonth = payments.filter((p) => {
    if (p.status !== 'SUCCEEDED') return false;
    const at = p.paidAt ?? p.createdAt;
    return at >= month.start && at <= month.end;
  });

  const sumPayments = (rows: typeof succeededMonth, filter?: (p: (typeof payments)[0]) => boolean) =>
    rows.filter(filter ?? (() => true)).reduce((s, p) => s + p.amountCents, 0);

  const countPayments = (rows: typeof succeededMonth, filter?: (p: (typeof payments)[0]) => boolean) =>
    rows.filter(filter ?? (() => true)).length;

  const isExcluded = (p: (typeof payments)[0]) =>
    shouldExcludeFromAnalytics({
      userEmail: p.user.email,
      stripePaymentIntentId: p.stripePaymentIntentId,
      stripeInvoiceId: p.stripeInvoiceId,
    }).exclude;

  const totalAll = sumPayments(succeededMonth);
  const totalClean = sumPayments(succeededMonth, (p) => !isExcluded(p));

  const stripeAll = sumPayments(
    succeededMonth,
    (p) => p.paymentMethod === 'STRIPE' || p.paymentMethod === 'TERMINAL',
  );
  const stripeClean = sumPayments(
    succeededMonth,
    (p) =>
      !isExcluded(p) && (p.paymentMethod === 'STRIPE' || p.paymentMethod === 'TERMINAL'),
  );

  const cashAll = sumPayments(succeededMonth, (p) => p.paymentMethod === 'CASH');
  const cashClean = sumPayments(succeededMonth, (p) => !isExcluded(p) && p.paymentMethod === 'CASH');

  const countAll = countPayments(succeededMonth);
  const countClean = countPayments(succeededMonth, (p) => !isExcluded(p));

  const pendingAll = payments
    .filter((p) => p.status === 'PENDING')
    .reduce((s, p) => s + p.amountCents, 0);
  const pendingClean = payments
    .filter((p) => p.status === 'PENDING' && !isExcluded(p))
    .reduce((s, p) => s + p.amountCents, 0);

  const currency = succeededMonth[0]?.currency ?? 'mxn';

  metricRow('Total cobrado', totalAll, totalClean, 'money', currency);
  metricRow('Cobrado por Stripe', stripeAll, stripeClean, 'money', currency);
  metricRow('Cobrado en efectivo', cashAll, cashClean, 'money', currency);
  metricRow('Pagos cobrados', countAll, countClean, 'count');

  metricRow('Pendiente por cobrar', pendingAll, pendingClean, 'money', currency);

  if (contaminatingPayments.length > 0) {
    console.log('\n  Registros que explican la diferencia (pagos del mes):');
    for (const p of succeededMonth.filter(isExcluded)) {
      console.log(
        `    - id:${p.id.slice(0, 12)}… ${p.user.email} ${formatMoney(p.amountCents, p.currency)} ` +
          `${p.paymentMethod} ${shouldExcludeFromAnalytics({
            userEmail: p.user.email,
            stripePaymentIntentId: p.stripePaymentIntentId,
            stripeInvoiceId: p.stripeInvoiceId,
          }).reason}`,
      );
    }
  }

  section('METRIC IMPACT — MEMBERSHIP & OPERATIONS (30 days)');

  const newMembersAll = memberships.filter(
    (m) =>
      m.role === 'MEMBER' &&
      !m.deletedAt &&
      m.createdAt >= days30.start &&
      !m.user.deletedAt,
  ).length;
  const newMembersClean = memberships.filter(
    (m) =>
      m.role === 'MEMBER' &&
      !m.deletedAt &&
      m.createdAt >= days30.start &&
      !m.user.deletedAt &&
      !shouldExcludeFromAnalytics({
        userEmail: m.user.email,
        stripePaymentIntentId: null,
        stripeInvoiceId: null,
      }).exclude,
  ).length;

  metricRow('Nuevas membresías (30d)', newMembersAll, newMembersClean, 'count');
  metricRow('Reservas (30d)', bookingsAll, bookingsAll - bookingsDemo, 'count');
  metricRow('Asistencias (30d)', attendancesAll, attendancesAll - attendancesDemo, 'count');

  const topCoachNew = newCoachRows[0];
  metricRow(
    'Coach más activo (clases, método corregido)',
    topCoachNew ? Number(topCoachNew.class_count) : 0,
    topCoachNew ? Number(topCoachNew.class_count) : 0,
    'count',
  );

  // ── Review account guidance ───────────────────────────────────────────────

  section('REVIEW ACCOUNT CLASSIFICATION');

  console.log(`
  apple.review@fraterunion.com
    Class: REQUIRED_REVIEW_ACCOUNT
    Role: MEMBER (Apple App Review)
    Payments: none (seed:ares-review never creates Payment rows)
    Analytics: EXCLUDE from owner KPIs — not real revenue/membership activity
    Operational: KEEP — must remain usable for App Store review

  staff.review@fraterunion.com
    Class: REQUIRED_REVIEW_ACCOUNT
    Role: FRONT_DESK
    Analytics: EXCLUDE if they generate test bookings/attendance; currently low impact
    Operational: KEEP — required for Apple review staff flows
`);

  // ── Exclusion model recommendation ────────────────────────────────────────

  section('RECOMMENDED EXCLUSION MODEL (not implemented)');

  console.log(`
  Preferred: Option A — explicit marker (smallest production-safe change)
    - Add studio_memberships.exclude_from_analytics BOOLEAN DEFAULT false
    - Set true for: member1-3@ares.demo, review accounts, legacy demo staff
    - Set false for: real coaches (@ares.demo coach emails), real members
    - Optionally payment.is_test_data for pi_demo_* rows

  Avoid: Option E alone — @ares.demo pattern would exclude REAL coaches

  Option B (separate demo studio): high migration cost, not needed if markers work

  Option C (cleanup): run cleanup:ares-demo after migration gates; does not help
    coaches who legitimately use @ares.demo emails

  Schema impact (Option A): one nullable/boolean column + seed script updates
  Query impact: add AND NOT exclude_from_analytics to analytics WHERE on user joins
  Risk: low if coaches/real members explicitly marked exclude=false
`);

  // ── Timezone consistency ──────────────────────────────────────────────────

  section('TIMEZONE CONSISTENCY (report only)');

  console.log(`
  Studio timezone: ${tz}

  Already studio-local (totals reconcile):
    - Financial KPIs (getFinancialSummary)
    - Financial revenue trend buckets

  Still UTC-grouped (day placement may shift ±1 near midnight CDMX):
    - getTrends bookings / attendances (date_trunc UTC)
    - getBusinessAnalytics member signup trend gap-fill (UTC ISO keys)

  Expected impact: period TOTALS unchanged; only intraday chart bucket edges may differ.
  Financial reconciliation flags (trend sum = total) should pass for current month.
`);

  // ── JSON summary ────────────────────────────────────────────────────────

  section('JSON SUMMARY');
  console.log(
    JSON.stringify(
      {
        event: 'audit_ares_analytics',
        studio: ARES_SLUG,
        studioId,
        runAt: now.toISOString(),
        membershipClassification: classCounts,
        payments: {
          total: payments.length,
          contaminating: contaminatingPayments.length,
          contaminatingIds: contaminatingPayments.map((p) => p.id),
        },
        scheduledClasses: {
          total: totalClasses,
          future: futureClasses,
          past: pastClasses,
          canceled: canceledClasses,
          legacyDemoTemplates: legacyTemplateClasses,
        },
        financialMonth: {
          totalCents: totalAll,
          totalCentsWithoutDemo: totalClean,
          differenceCents: totalAll - totalClean,
          currency,
        },
        coachTop30d: {
          old: oldCoachRows[0]
            ? {
                name: `${oldCoachRows[0].first_name} ${oldCoachRows[0].last_name}`,
                email: oldCoachRows[0].email,
                oldCount: Number(oldCoachRows[0].class_count),
                newCount: newMap.get(oldCoachRows[0].email) ?? 0,
                futureInOld: Number(oldCoachRows[0].future_included),
              }
            : null,
        },
        readOnly: true,
        dataModified: false,
      },
      null,
      2,
    ),
  );

  console.log('\n✓ Audit complete. No data was modified.');
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
