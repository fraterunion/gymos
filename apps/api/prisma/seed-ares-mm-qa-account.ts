/**
 * Ares Training Club — MM-5 dual-membership QA account (production-safe upsert).
 *
 * Creates or refreshes ONLY this email:
 *   mm.qa@fraterunion.com — MEMBER holding TWO simultaneous local memberships
 *     · Pro                 CASH · ACTIVE · exclusiveGroupKey 'CORE' · cancelAtPeriodEnd false
 *     · Booty Lab by Etzia  CASH · ACTIVE · exclusiveGroupKey NULL   · cancelAtPeriodEnd true
 *   plus the covering MembershipEntitlementCycle the fixed-duration plan needs, and an
 *   acceptance of the currently active studio waiver so booking QA can be exercised.
 *
 * Why a seed and not the sales API: creating a second simultaneous membership through
 * SalesService is refused while MULTI_MEMBERSHIP_ENABLED is off ("Additional simultaneous
 * memberships are not enabled for this studio"). This script writes the rows directly, so
 * the QA account exists WITHOUT enabling the flag anywhere.
 *
 * Never touches any other user (every statement is keyed by this email). Never calls
 * Stripe, never creates Payment/Booking/Attendance rows, never deletes on the normal path.
 * Both memberships are local-only (source CASH, stripeSubscriptionId NULL), and the studio
 * membership is flagged excludeFromAnalytics so owner metrics stay clean.
 *
 * Safe to re-run: one User, one StudioMembership, one Subscription per plan and one
 * covering entitlement cycle, no matter how many times it runs. The interval (Pro) window
 * is refreshed on each run; the fixed-duration (Booty) window is pinned to whichever
 * entitlement cycle currently covers now, because that ledger is append-only in the DB
 * (trigger membership_entitlement_cycles_immutable_nonoverlap rejects UPDATE and DELETE).
 * A new cycle is opened only once the previous one has lapsed, exactly like a cash renewal.
 *
 * DRY RUN (zero writes):
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api seed:ares-mm-qa
 *
 * Provision:
 *   DATABASE_URL="postgresql://..." pnpm --filter api seed:ares-mm-qa
 *
 * Cleanup — retires ONLY this account (aborts if any Payment exists): deletes its activity
 * rows, CANCELs both memberships, and soft-deletes the user + studio membership so login is
 * refused. The entitlement-cycle ledger is kept because the DB forbids deleting it; running
 * provisioning again restores the account.
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api seed:ares-mm-qa:cleanup
 *   DATABASE_URL="postgresql://..." pnpm --filter api seed:ares-mm-qa:cleanup
 */

import * as bcrypt from 'bcrypt';
import {
  PrismaClient,
  Role,
  SubscriptionSource,
  SubscriptionStatus,
  WaiverAcceptanceMethod,
} from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';
const CLEANUP = process.argv.includes('--cleanup');

const ARES_SLUG = 'ares-fitness';

const QA_EMAIL = 'mm.qa@fraterunion.com';
const QA_PASSWORD = 'MmQa2026!';
const QA_FIRST_NAME = 'MM QA';
const QA_LAST_NAME = 'Dual Membership';
const QA_NOTES = 'MM-5 QA account — synthetic, no revenue, no Stripe';

const PRO_PLAN_NAME = 'Pro';
const BOOTY_PLAN_NAME = 'Booty Lab by Etzia';
const CORE_EXCLUSIVE_GROUP = 'CORE';

/** Entitlement windows: started a week ago so both memberships read as currently entitled. */
const ENTITLED_SINCE_DAYS = 7;
/** Interval plans have no entitlementDays — give the QA row a long, obviously synthetic window. */
const INTERVAL_WINDOW_DAYS = 365;

/** Mirrors RENEWABLE_SUBSCRIPTION_STATUSES (src/memberships/membership-entitlement.ts).
 *  Inlined so this seed stays dependency-free, like the other prisma/ seeds. */
const RENEWABLE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
];

function log(op: string, entity: string, detail: string): void {
  const prefix = DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]';
  console.log(`${prefix} ${op.padEnd(7)} ${entity.padEnd(28)} ${detail}`);
}

function fail(message: string): never {
  throw new Error(`MM QA SEED ABORT: ${message}`);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12);
}

type QaPlan = {
  id: string;
  name: string;
  classCredits: number | null;
  entitlementDays: number | null;
  exclusiveGroup: string | null;
};

async function loadStudioId(): Promise<string> {
  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true, slug: true },
  });
  if (!studio) {
    fail(
      `studio not found: ${ARES_SLUG}. Verify DATABASE_URL points at the right database.`,
    );
  }
  console.log(`Studio: ${studio.name} (${studio.slug}) ${studio.id}\n`);
  return studio.id;
}

async function loadPlan(studioId: string, name: string): Promise<QaPlan> {
  const plan = await prisma.membershipPlan.findFirst({
    where: { studioId, name, deletedAt: null, active: true },
    select: {
      id: true,
      name: true,
      classCredits: true,
      entitlementDays: true,
      exclusiveGroup: true,
    },
  });
  if (!plan) {
    fail(`active membership plan "${name}" not found for ${ARES_SLUG}.`);
  }
  return plan;
}

/**
 * Fail-closed compatibility gate — asserted BEFORE any write. These two snapshots are the
 * whole point of the QA account: a CORE membership stacked with a group-less one. If the
 * catalog no longer has that shape, provisioning would create rows that either violate the
 * per-group unique index or fail to exercise the multi-membership UI at all.
 */
function assertPlanCompatibility(pro: QaPlan, booty: QaPlan): void {
  if (pro.exclusiveGroup !== CORE_EXCLUSIVE_GROUP) {
    fail(
      `plan "${pro.name}" must have exclusiveGroup '${CORE_EXCLUSIVE_GROUP}' (found ${pro.exclusiveGroup ?? 'NULL'}).`,
    );
  }
  if (booty.exclusiveGroup !== null) {
    fail(
      `plan "${booty.name}" must have exclusiveGroup NULL to be stackable (found ${booty.exclusiveGroup}).`,
    );
  }
  if (pro.entitlementDays !== null) {
    fail(
      `plan "${pro.name}" is expected to be interval-billed (entitlementDays NULL, found ${pro.entitlementDays}).`,
    );
  }
  if (booty.entitlementDays === null) {
    fail(
      `plan "${booty.name}" is expected to be fixed-duration (entitlementDays set, found NULL).`,
    );
  }
  if (pro.classCredits !== 5) {
    console.log(
      `  NOTE  "${pro.name}" classCredits is ${pro.classCredits ?? 'unlimited'} (plan of record; QA expected 5).`,
    );
  }
  if (booty.classCredits !== 4) {
    console.log(
      `  NOTE  "${booty.name}" classCredits is ${booty.classCredits ?? 'unlimited'} (plan of record; QA expected 4).`,
    );
  }
  console.log(
    `Plans: ${pro.name} (CORE, credits=${pro.classCredits ?? 'unlimited'}) + ` +
      `${booty.name} (stackable, credits=${booty.classCredits ?? 'unlimited'}, ${booty.entitlementDays}d)\n`,
  );
}

async function upsertQaUser(): Promise<string | null> {
  log('UPSERT', 'User', QA_EMAIL);
  if (DRY_RUN) {
    const existing = await prisma.user.findUnique({
      where: { email: QA_EMAIL },
      select: { id: true },
    });
    return existing?.id ?? null;
  }
  const user = await prisma.user.upsert({
    where: { email: QA_EMAIL },
    create: {
      email: QA_EMAIL,
      firstName: QA_FIRST_NAME,
      lastName: QA_LAST_NAME,
      passwordHash: hashPassword(QA_PASSWORD),
    },
    update: {
      firstName: QA_FIRST_NAME,
      lastName: QA_LAST_NAME,
      passwordHash: hashPassword(QA_PASSWORD),
      deletedAt: null,
    },
    select: { id: true },
  });
  return user.id;
}

async function upsertQaStudioMembership(
  studioId: string,
  userId: string | null,
): Promise<void> {
  log('UPSERT', 'StudioMembership', `MEMBER excludeFromAnalytics=true`);
  if (DRY_RUN || userId === null) return;
  await prisma.studioMembership.upsert({
    where: { userId_studioId: { userId, studioId } },
    create: { studioId, userId, role: Role.MEMBER, excludeFromAnalytics: true },
    update: { role: Role.MEMBER, excludeFromAnalytics: true, deletedAt: null },
  });
}

/**
 * Refuses to proceed if this QA user somehow holds a renewable membership outside the two
 * QA plans — that row could collide with the per-group unique index or silently change what
 * the UI shows. Fail-closed rather than "fix" data this script does not own.
 */
async function assertNoForeignRenewableMemberships(
  studioId: string,
  userId: string,
  qaPlanIds: string[],
): Promise<void> {
  const foreign = await prisma.subscription.findMany({
    where: {
      studioId,
      userId,
      status: { in: RENEWABLE_STATUSES },
      membershipPlanId: { notIn: qaPlanIds },
    },
    select: { id: true, membershipPlanId: true, status: true },
  });
  if (foreign.length > 0) {
    fail(
      `QA user holds ${foreign.length} renewable membership(s) outside the QA plans ` +
        `(${foreign.map((f) => `${f.id}:${f.status}`).join(', ')}). Resolve manually before re-running.`,
    );
  }
}

/**
 * One subscription row per QA plan, ever. Keyed by (studio, user, plan) rather than a unique
 * constraint because subscriptions carry no such Prisma-level unique — the DB's partial
 * indexes only forbid duplicate RENEWABLE rows, so idempotency is enforced here.
 */
async function upsertQaSubscription(params: {
  studioId: string;
  userId: string | null;
  plan: QaPlan;
  periodStart: Date;
  periodEnd: Date;
  entitlementEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
}): Promise<string | null> {
  const {
    studioId,
    userId,
    plan,
    periodStart,
    periodEnd,
    entitlementEndsAt,
    cancelAtPeriodEnd,
  } = params;
  const existingId = await findQaSubscriptionId(studioId, userId, plan.id);
  const existing = existingId === null ? null : { id: existingId };

  const shape = {
    status: SubscriptionStatus.ACTIVE,
    source: SubscriptionSource.CASH,
    stripeSubscriptionId: null,
    exclusiveGroupKey: plan.exclusiveGroup,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    entitlementEndsAt,
    cancelAtPeriodEnd,
    supersededBySubscriptionId: null,
    endReason: null,
    notes: QA_NOTES,
  };
  const detail =
    `${plan.name} ACTIVE CASH group=${plan.exclusiveGroup ?? 'NULL'} ` +
    `cancelAtPeriodEnd=${cancelAtPeriodEnd} entitlementEndsAt=${entitlementEndsAt?.toISOString() ?? 'null'}`;

  if (existing) {
    log('UPDATE', 'Subscription', detail);
    if (DRY_RUN) return existing.id;
    const updated = await prisma.subscription.update({
      where: { id: existing.id },
      data: shape,
      select: { id: true },
    });
    return updated.id;
  }

  log('CREATE', 'Subscription', detail);
  if (DRY_RUN || userId === null) return null;
  const created = await prisma.subscription.create({
    data: { studioId, userId, membershipPlanId: plan.id, ...shape },
    select: { id: true },
  });
  return created.id;
}

async function findQaSubscriptionId(
  studioId: string,
  userId: string | null,
  membershipPlanId: string,
): Promise<string | null> {
  if (userId === null) return null;
  const row = await prisma.subscription.findFirst({
    where: { studioId, userId, membershipPlanId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * Entitlement cycles are an append-only ledger: the DB trigger
 * `membership_entitlement_cycles_immutable_nonoverlap` rejects every UPDATE and DELETE
 * ("membership entitlement cycles are immutable") and rejects INSERTs that overlap an
 * existing cycle for the same subscription. So idempotency here means:
 *   · a cycle already covering NOW  → reuse it untouched, and align the subscription window
 *     to that exact cycle (entitlement and ledger can never disagree)
 *   · otherwise                      → open a fresh cycle that starts no earlier than the
 *     last one ended, exactly as a real cash renewal does
 */
async function resolveBootyWindow(params: {
  subscriptionId: string | null;
  defaultStart: Date;
  entitlementDays: number;
  now: Date;
}): Promise<{ startsAt: Date; endsAt: Date; cycleExists: boolean }> {
  const { subscriptionId, defaultStart, entitlementDays, now } = params;
  const windowFrom = (start: Date) =>
    new Date(start.getTime() + entitlementDays * 86_400_000);

  if (subscriptionId === null) {
    return {
      startsAt: defaultStart,
      endsAt: windowFrom(defaultStart),
      cycleExists: false,
    };
  }

  const covering = await prisma.membershipEntitlementCycle.findFirst({
    where: { subscriptionId, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: { startsAt: 'desc' },
    select: { startsAt: true, endsAt: true },
  });
  if (covering) {
    return {
      startsAt: covering.startsAt,
      endsAt: covering.endsAt,
      cycleExists: true,
    };
  }

  const latest = await prisma.membershipEntitlementCycle.findFirst({
    where: { subscriptionId },
    orderBy: { endsAt: 'desc' },
    select: { endsAt: true },
  });
  const startsAt =
    latest && latest.endsAt > defaultStart ? latest.endsAt : defaultStart;
  if (startsAt > now) {
    fail(
      `existing entitlement cycles for subscription ${subscriptionId} run past now ` +
        `(next free start ${startsAt.toISOString()}) — a new cycle would leave the QA account not currently entitled.`,
    );
  }
  return { startsAt, endsAt: windowFrom(startsAt), cycleExists: false };
}

/** Append-only INSERT; never called when a covering cycle already exists. */
async function createQaEntitlementCycle(params: {
  studioId: string;
  userId: string | null;
  subscriptionId: string | null;
  plan: QaPlan;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  const { studioId, userId, subscriptionId, plan, startsAt, endsAt } = params;
  log(
    'CREATE',
    'MembershipEntitlementCycle',
    `${plan.name} ${startsAt.toISOString()} → ${endsAt.toISOString()} creditLimit=${plan.classCredits ?? 'null'}`,
  );
  if (DRY_RUN || userId === null || subscriptionId === null) return;
  await prisma.membershipEntitlementCycle.create({
    data: {
      studioId,
      userId,
      subscriptionId,
      membershipPlanId: plan.id,
      startsAt,
      endsAt,
      creditLimit: plan.classCredits,
      source: SubscriptionSource.CASH,
      stripeInvoiceId: null,
    },
  });
}

/** Accepts the CURRENTLY ACTIVE waiver document — the exact row getWaiverStatus looks up. */
async function upsertQaWaiverAcceptance(
  studioId: string,
  userId: string | null,
): Promise<string> {
  const active = await prisma.studioWaiverDocument.findFirst({
    where: { studioId, isActive: true },
    orderBy: { effectiveAt: 'desc' },
    select: { id: true, version: true },
  });
  if (!active) {
    fail(
      'no active StudioWaiverDocument for this studio — booking QA would be blocked by the waiver gate.',
    );
  }

  log('UPSERT', 'WaiverAcceptance', `${active.version} (${active.id})`);
  if (DRY_RUN || userId === null) return active.version;

  await prisma.waiverAcceptance.upsert({
    where: {
      studioId_userId_waiverDocumentId: {
        studioId,
        userId,
        waiverDocumentId: active.id,
      },
    },
    create: {
      studioId,
      userId,
      waiverDocumentId: active.id,
      waiverVersion: active.version,
      method: WaiverAcceptanceMethod.STAFF_ATTESTED,
      attestationNote: 'MM-5 QA account provisioning (seed)',
    },
    update: {
      waiverVersion: active.version,
      method: WaiverAcceptanceMethod.STAFF_ATTESTED,
      attestationNote: 'MM-5 QA account provisioning (seed)',
    },
  });
  return active.version;
}

async function provision(): Promise<void> {
  const studioId = await loadStudioId();
  const pro = await loadPlan(studioId, PRO_PLAN_NAME);
  const booty = await loadPlan(studioId, BOOTY_PLAN_NAME);
  assertPlanCompatibility(pro, booty);

  const now = new Date();
  const periodStart = addDays(now, -ENTITLED_SINCE_DAYS);
  const proPeriodEnd = addDays(periodStart, INTERVAL_WINDOW_DAYS);

  const userId = await upsertQaUser();
  await upsertQaStudioMembership(studioId, userId);
  if (userId !== null) {
    await assertNoForeignRenewableMemberships(studioId, userId, [
      pro.id,
      booty.id,
    ]);
  }

  const proSubscriptionId = await upsertQaSubscription({
    studioId,
    userId,
    plan: pro,
    periodStart,
    periodEnd: proPeriodEnd,
    entitlementEndsAt: null,
    cancelAtPeriodEnd: false,
  });

  // Booty's window is dictated by the append-only cycle ledger, resolved BEFORE the
  // subscription write so entitlement and ledger always describe the same period.
  const existingBootySubscriptionId = await findQaSubscriptionId(
    studioId,
    userId,
    booty.id,
  );
  const bootyWindow = await resolveBootyWindow({
    subscriptionId: existingBootySubscriptionId,
    defaultStart: periodStart,
    entitlementDays: booty.entitlementDays!,
    now,
  });
  if (bootyWindow.cycleExists) {
    log(
      'REUSE',
      'MembershipEntitlementCycle',
      `${booty.name} ${bootyWindow.startsAt.toISOString()} → ${bootyWindow.endsAt.toISOString()} (immutable ledger)`,
    );
  }

  const bootySubscriptionId = await upsertQaSubscription({
    studioId,
    userId,
    plan: booty,
    periodStart: bootyWindow.startsAt,
    periodEnd: bootyWindow.endsAt,
    entitlementEndsAt: bootyWindow.endsAt,
    cancelAtPeriodEnd: true,
  });

  if (!bootyWindow.cycleExists) {
    await createQaEntitlementCycle({
      studioId,
      userId,
      subscriptionId: bootySubscriptionId,
      plan: booty,
      startsAt: bootyWindow.startsAt,
      endsAt: bootyWindow.endsAt,
    });
  }

  const waiverVersion = await upsertQaWaiverAcceptance(studioId, userId);

  console.log('');
  console.log(
    JSON.stringify(
      {
        event: 'seed_ares_mm_qa_account_complete',
        studio: ARES_SLUG,
        dry_run: DRY_RUN,
        account: {
          email: QA_EMAIL,
          password: QA_PASSWORD,
          role: Role.MEMBER,
          excludeFromAnalytics: true,
        },
        memberships: [
          {
            plan: pro.name,
            subscriptionId: proSubscriptionId,
            source: SubscriptionSource.CASH,
            exclusiveGroupKey: CORE_EXCLUSIVE_GROUP,
            credits: pro.classCredits,
            currentPeriodStart: periodStart.toISOString(),
            currentPeriodEnd: proPeriodEnd.toISOString(),
            entitlementEndsAt: null,
            cancelAtPeriodEnd: false,
          },
          {
            plan: booty.name,
            subscriptionId: bootySubscriptionId,
            source: SubscriptionSource.CASH,
            exclusiveGroupKey: null,
            credits: booty.classCredits,
            currentPeriodStart: bootyWindow.startsAt.toISOString(),
            currentPeriodEnd: bootyWindow.endsAt.toISOString(),
            entitlementEndsAt: bootyWindow.endsAt.toISOString(),
            cancelAtPeriodEnd: true,
            entitlementCycle: bootyWindow.cycleExists
              ? 'reused existing covering cycle'
              : 'new cycle created',
          },
        ],
        waiverVersion,
        stripe:
          'never contacted; no customer, subscription, price or invoice created',
        payments_created: 0,
        bookings_created: 0,
        attendances_created: 0,
      },
      null,
      2,
    ),
  );
}

/** Relations that would mean this account is NOT a disposable QA member. Cleanup refuses
 *  to touch an account carrying any of them rather than deleting someone else's history. */
async function assertCleanupSafety(userId: string): Promise<void> {
  const [
    payments,
    paymentsRecorded,
    attendancesRecorded,
    subscriptionsCreated,
    auditLogs,
    staffProfiles,
    instructedClasses,
    waiverAttestations,
    operationalNotesAuthored,
  ] = await Promise.all([
    prisma.payment.count({ where: { userId } }),
    prisma.payment.count({ where: { recordedByUserId: userId } }),
    prisma.attendance.count({ where: { checkedInByUserId: userId } }),
    prisma.subscription.count({ where: { createdByUserId: userId } }),
    prisma.auditLog.count({ where: { actorUserId: userId } }),
    prisma.studioStaffProfile.count({ where: { userId } }),
    prisma.scheduledClass.count({ where: { instructorId: userId } }),
    prisma.waiverAcceptance.count({ where: { attestedByUserId: userId } }),
    prisma.memberOperationalNote.count({ where: { authorUserId: userId } }),
  ]);

  if (payments > 0) {
    fail(
      `${payments} Payment row(s) exist for ${QA_EMAIL} — refusing to delete an account with financial history.`,
    );
  }
  const staffLike = {
    paymentsRecorded,
    attendancesRecorded,
    subscriptionsCreated,
    auditLogs,
    staffProfiles,
    instructedClasses,
    waiverAttestations,
    operationalNotesAuthored,
  };
  const offending = Object.entries(staffLike).filter(([, n]) => n > 0);
  if (offending.length > 0) {
    fail(
      `${QA_EMAIL} carries staff/operator references (${offending.map(([k, n]) => `${k}=${n}`).join(', ')}) — ` +
        'refusing to delete rows this script does not own.',
    );
  }
}

async function cleanup(): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: QA_EMAIL },
    select: { id: true, email: true },
  });
  if (!user) {
    console.log(`Nothing to clean: ${QA_EMAIL} does not exist.`);
    return;
  }
  // Defense in depth: every delete below is keyed by this id, and this id resolved from
  // the QA email literal. Re-assert before any destructive statement.
  if (user.email !== QA_EMAIL) {
    fail(`resolved user ${user.id} is ${user.email}, not ${QA_EMAIL}.`);
  }
  const userId = user.id;

  await assertCleanupSafety(userId);

  const cycles = await prisma.membershipEntitlementCycle.count({
    where: { userId },
  });

  const deletable = {
    refreshTokens: await prisma.refreshToken.count({ where: { userId } }),
    qrTokens: await prisma.qRToken.count({ where: { userId } }),
    walletCredentials: await prisma.walletCredential.count({
      where: { userId },
    }),
    bookings: await prisma.booking.count({ where: { userId } }),
    waitlistEntries: await prisma.waitlistEntry.count({ where: { userId } }),
    attendances: await prisma.attendance.count({ where: { userId } }),
    dayPasses: await prisma.dayPass.count({ where: { userId } }),
    enrollments: await prisma.memberEnrollment.count({ where: { userId } }),
    operationalNotes: await prisma.memberOperationalNote.count({
      where: { memberUserId: userId },
    }),
    memberProfiles: await prisma.studioMemberProfile.count({
      where: { userId },
    }),
    waiverAcceptances: await prisma.waiverAcceptance.count({
      where: { userId },
    }),
  };
  const subscriptions = await prisma.subscription.count({ where: { userId } });

  for (const [entity, n] of Object.entries(deletable)) {
    log('DELETE', entity, `${n} row(s)`);
  }
  log(
    'CANCEL',
    'Subscription',
    `${subscriptions} row(s) → CANCELED, not entitled`,
  );
  log('RETIRE', 'StudioMembership', 'deletedAt = now');
  log(
    'RETIRE',
    'User',
    `${QA_EMAIL} (${userId}) deletedAt = now → login refused`,
  );
  log(
    'KEEP',
    'MembershipEntitlementCycle',
    `${cycles} row(s) — immutable ledger, DB forbids DELETE`,
  );

  if (DRY_RUN) {
    console.log('\nDRY RUN — nothing was deleted or retired.');
    return;
  }

  const retiredAt = new Date();
  // FK-safe order: activity rows first, then memberships are retired in place. The user row
  // is soft-deleted rather than dropped because membership_entitlement_cycles is an
  // append-only ledger (trigger blocks DELETE) and its FK to users is onDelete: Restrict —
  // a hard delete is impossible by design once any cycle exists.
  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.deleteMany({ where: { userId } });
    await tx.qRToken.deleteMany({ where: { userId } });
    await tx.walletCredential.deleteMany({ where: { userId } });
    await tx.booking.deleteMany({ where: { userId } });
    await tx.waitlistEntry.deleteMany({ where: { userId } });
    await tx.attendance.deleteMany({ where: { userId } });
    await tx.dayPass.deleteMany({ where: { userId } });
    await tx.memberEnrollment.deleteMany({ where: { userId } });
    await tx.memberOperationalNote.deleteMany({
      where: { memberUserId: userId },
    });
    await tx.studioMemberProfile.deleteMany({ where: { userId } });
    await tx.waiverAcceptance.deleteMany({ where: { userId } });
    await tx.subscription.updateMany({
      where: { userId },
      data: {
        status: SubscriptionStatus.CANCELED,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: retiredAt,
        entitlementEndsAt: retiredAt,
        notes: `${QA_NOTES} — retired ${retiredAt.toISOString()}`,
      },
    });
    await tx.studioMembership.updateMany({
      where: { userId },
      data: { deletedAt: retiredAt },
    });
    await tx.user.update({
      where: { id: userId },
      data: { deletedAt: retiredAt },
    });
  });

  console.log('');
  console.log(
    JSON.stringify(
      {
        event: 'seed_ares_mm_qa_account_cleanup_complete',
        email: QA_EMAIL,
        userId,
        deleted: deletable,
        subscriptionsCanceled: subscriptions,
        entitlementCyclesKept: cycles,
        userSoftDeletedAt: retiredAt.toISOString(),
        note: 'login refused, no entitlement, hidden from member lists; re-run provisioning to restore',
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log('════════════════════════════════════════════════');
    console.log('  DRY RUN — zero writes will occur');
    console.log('════════════════════════════════════════════════\n');
  }
  console.log(
    `Mode: ${CLEANUP ? 'CLEANUP' : 'PROVISION'}  Account: ${QA_EMAIL}\n`,
  );

  if (CLEANUP) {
    await cleanup();
    return;
  }
  await provision();
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
