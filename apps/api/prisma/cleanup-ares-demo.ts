/**
 * ARES Fitness — demo data cleanup script.
 *
 * SAFE BY DEFAULT: runs in DRY_RUN mode unless LIVE_RUN=true is explicitly set.
 * Every write is logged before execution. All decisions are re-verified at
 * runtime against the live DB — never trusts prior diagnostic output alone.
 *
 * What this script does:
 *   1. Cancels future ScheduledClasses for legacy demo templates
 *      (status → CANCELLED, cancelReason set — bookings/attendance/waitlist untouched)
 *   2. Soft-deletes legacy demo ClassTemplates (sets deleted_at = now)
 *   3. Soft-deletes Unlimited Strength and Flex 8 MembershipPlans
 *      (active = false, deleted_at = now — all subscriptions kept intact)
 *   4. TURBO MembershipPlan:
 *      hard-deletes if runtime count confirms 0 subscriptions + 0 payments;
 *      falls back to soft-delete if that condition is not met.
 *   5. Soft-deletes StudioMembership for legacy demo staff emails
 *      (sets deleted_at = now on the membership row — User record is never touched)
 *
 * What this script NEVER does:
 *   Delete or modify Bookings, Attendance, WaitlistEntries, or Payments.
 *   Delete Subscriptions (real Stripe or demo).
 *   Delete User records.
 *   Touch any studio other than ares-fitness.
 *   Touch the ARES real coaches (Yayo, Coco, Karen, Fer, Estefy, Mau) or real plans.
 *
 * Usage:
 *   DRY_RUN  : DATABASE_URL="postgresql://..." pnpm --filter api cleanup:ares-demo
 *   LIVE RUN : DATABASE_URL="postgresql://..." LIVE_RUN=true pnpm --filter api cleanup:ares-demo
 */

import { ClassStatus, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ARES_SLUG = 'ares-fitness';
const DRY_RUN = process.env.LIVE_RUN !== 'true';
const CANCEL_REASON = 'Replaced by ARES real schedule';

const DEMO_TEMPLATE_NAMES = [
  'Power Hour',
  'MetCon Small Group',
  'Mobility & Breath',
] as const;

const SOFT_DELETE_PLAN_NAMES = ['Unlimited Strength', 'Flex 8'] as const;

// instructor + staff: only blocked by refresh tokens (operational). Handled below.
const DEMO_STAFF_EMAILS = ['instructor@ares.demo', 'staff@ares.demo'] as const;

// admin@ares.demo is explicitly excluded: diagnostic confirmed bookings=4 and build_jobs=24.
// Do not touch until those are resolved and a separate decision is made.
const STAFF_ALWAYS_SKIP = ['admin@ares.demo'] as const;

// ─── Output helpers ───────────────────────────────────────────────────────────

function write(op: string, entity: string, detail: string): void {
  const mode = DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]';
  console.log(`${mode} ${op.padEnd(10)} ${entity.padEnd(24)} ${detail}`);
}

function skip(entity: string, detail: string): void {
  console.log(`[SKIP   ] ${''.padEnd(10)} ${entity.padEnd(24)} ${detail}`);
}

function gate(msg: string): void {
  console.log(`\n  !! GATE: ${msg}`);
}

function section(title: string): void {
  const fill = '─'.repeat(Math.max(2, 64 - title.length - 4));
  console.log(`\n── ${title} ${fill}`);
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface TemplateResult {
  name: string;
  found: boolean;
  futureCancelledCount: number;
  action: 'SOFT_DELETE' | 'SKIP';
}

interface PlanResult {
  name: string;
  found: boolean;
  action: 'SOFT_DELETE' | 'HARD_DELETE' | 'SKIP';
  subscriptionCount: number;
  realStripeCount: number;
}

interface StaffMembershipResult {
  email: string;
  userId: string | null;
  userFound: boolean;
  membershipFound: boolean;
  alreadySoftDeleted: boolean;
  bookingCount: number;
  subscriptionCount: number;
  paymentCount: number;
  attendanceCount: number;
  waitlistCount: number;
  qrTokenCount: number;
  refreshTokenCount: number;
  buildJobCount: number;
  // Refresh tokens deleted before the membership soft-delete (operational data only)
  refreshTokensDeleted: number;
  action: 'SOFT_DELETE' | 'DO_NOT_DELETE' | 'SKIP';
}

// ─── Template: cancel future classes + soft-delete ────────────────────────────

async function processTemplate(
  studioId: string,
  name: string,
  now: Date,
): Promise<TemplateResult> {
  const template = await prisma.classTemplate.findFirst({
    where: { studioId, name, deletedAt: null },
    select: { id: true },
  });

  if (!template) {
    skip('ClassTemplate', `"${name}" — not found or already soft-deleted`);
    return { name, found: false, futureCancelledCount: 0, action: 'SKIP' };
  }

  const futureCount = await prisma.scheduledClass.count({
    where: {
      studioId,
      classTemplateId: template.id,
      startsAt: { gt: now },
      status: { not: ClassStatus.CANCELLED },
    },
  });

  write(
    'UPDATE',
    'ScheduledClass',
    `"${name}" — cancel ${futureCount} future class(es) → status=CANCELLED`,
  );
  if (!DRY_RUN) {
    await prisma.scheduledClass.updateMany({
      where: {
        studioId,
        classTemplateId: template.id,
        startsAt: { gt: now },
        status: { not: ClassStatus.CANCELLED },
      },
      data: { status: ClassStatus.CANCELLED, cancelReason: CANCEL_REASON },
    });
  }

  write('SOFT_DEL', 'ClassTemplate', `"${name}" — set deleted_at = now`);
  if (!DRY_RUN) {
    await prisma.classTemplate.update({
      where: { id: template.id },
      data: { deletedAt: now },
    });
  }

  return { name, found: true, futureCancelledCount: futureCount, action: 'SOFT_DELETE' };
}

// ─── Plan: soft-delete (subscriptions kept intact) ────────────────────────────

async function softDeletePlan(
  studioId: string,
  name: string,
  now: Date,
): Promise<PlanResult> {
  const plan = await prisma.membershipPlan.findFirst({
    where: { studioId, name, deletedAt: null },
    select: { id: true },
  });

  if (!plan) {
    skip('MembershipPlan', `"${name}" — not found or already soft-deleted`);
    return { name, found: false, action: 'SKIP', subscriptionCount: 0, realStripeCount: 0 };
  }

  const [subscriptionCount, realStripeCount] = await Promise.all([
    prisma.subscription.count({ where: { membershipPlanId: plan.id } }),
    prisma.subscription.count({
      where: {
        membershipPlanId: plan.id,
        stripeSubscriptionId: { not: null },
        NOT: { stripeSubscriptionId: { startsWith: 'sub_demo_' } },
      },
    }),
  ]);

  write(
    'SOFT_DEL',
    'MembershipPlan',
    `"${name}" — active=false, deleted_at=now` +
      (realStripeCount > 0 ? ` (${realStripeCount} real Stripe sub(s) kept intact)` : ''),
  );
  if (!DRY_RUN) {
    await prisma.membershipPlan.update({
      where: { id: plan.id },
      data: { active: false, deletedAt: now },
    });
  }

  return { name, found: true, action: 'SOFT_DELETE', subscriptionCount, realStripeCount };
}

// ─── TURBO: runtime-verified conditional delete ───────────────────────────────

async function processTurbo(studioId: string, now: Date): Promise<PlanResult> {
  const plan = await prisma.membershipPlan.findFirst({
    where: { studioId, name: 'TURBO', deletedAt: null },
    select: { id: true },
  });

  if (!plan) {
    skip('MembershipPlan', '"TURBO" — not found or already removed');
    return { name: 'TURBO', found: false, action: 'SKIP', subscriptionCount: 0, realStripeCount: 0 };
  }

  const [subscriptionCount, paymentCount] = await Promise.all([
    prisma.subscription.count({ where: { membershipPlanId: plan.id } }),
    prisma.payment.count({ where: { membershipPlanId: plan.id } }),
  ]);

  if (subscriptionCount > 0 || paymentCount > 0) {
    gate(
      `TURBO has ${subscriptionCount} subscription(s) and ${paymentCount} payment(s) at runtime. ` +
        'Cannot hard-delete. Falling back to soft-delete.',
    );
    write('SOFT_DEL', 'MembershipPlan', '"TURBO" — active=false, deleted_at=now (hard-delete gate failed)');
    if (!DRY_RUN) {
      await prisma.membershipPlan.update({
        where: { id: plan.id },
        data: { active: false, deletedAt: now },
      });
    }
    return { name: 'TURBO', found: true, action: 'SOFT_DELETE', subscriptionCount, realStripeCount: 0 };
  }

  write('DELETE', 'MembershipPlan', '"TURBO" — hard delete (runtime confirmed: 0 subs, 0 payments)');
  if (!DRY_RUN) {
    await prisma.membershipPlan.delete({ where: { id: plan.id } });
  }

  return { name: 'TURBO', found: true, action: 'HARD_DELETE', subscriptionCount: 0, realStripeCount: 0 };
}

// ─── Demo staff: soft-delete StudioMembership only ───────────────────────────
//
// StudioMembership has deletedAt — soft-delete removes the user from the Staff
// screen without touching the User record.
//
// RefreshTokens are treated as operational data (created by any login session).
// If the only blocker is refresh tokens, they are deleted first, then the
// membership is soft-deleted. All other blocking data (bookings, subscriptions,
// payments, attendance, waitlist, qrTokens, buildJobs) still gates the operation.
//
// The User record is NEVER deleted.

async function processStaffMembership(
  studioId: string,
  email: string,
  now: Date,
): Promise<StaffMembershipResult> {
  const emptyResult = (
    extra: Partial<StaffMembershipResult> = {},
  ): StaffMembershipResult => ({
    email,
    userId: null,
    userFound: false,
    membershipFound: false,
    alreadySoftDeleted: false,
    bookingCount: 0,
    subscriptionCount: 0,
    paymentCount: 0,
    attendanceCount: 0,
    waitlistCount: 0,
    qrTokenCount: 0,
    refreshTokenCount: 0,
    buildJobCount: 0,
    refreshTokensDeleted: 0,
    action: 'SKIP',
    ...extra,
  });

  // Step 1: locate user
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, firstName: true, lastName: true },
  });

  if (!user) {
    skip('StudioMembership', `${email} — user not found in DB`);
    return emptyResult();
  }

  // Step 2: locate membership in ares-fitness
  const membership = await prisma.studioMembership.findUnique({
    where: { userId_studioId: { userId: user.id, studioId } },
    select: { id: true, role: true, deletedAt: true },
  });

  if (!membership) {
    skip('StudioMembership', `${email} (${user.firstName} ${user.lastName}) — no membership in ares-fitness`);
    return emptyResult({ userId: user.id, userFound: true });
  }

  if (membership.deletedAt !== null) {
    skip('StudioMembership', `${email} — already soft-deleted`);
    return emptyResult({ userId: user.id, userFound: true, membershipFound: true, alreadySoftDeleted: true });
  }

  // Step 3: count all data attached to this user (scoped where possible)
  const [
    bookingCount,
    subscriptionCount,
    paymentCount,
    attendanceCount,
    waitlistCount,
    qrTokenCount,
    refreshTokenCount,
    buildJobCount,
  ] = await Promise.all([
    prisma.booking.count({ where: { userId: user.id, studioId } }),
    prisma.subscription.count({ where: { userId: user.id, studioId } }),
    prisma.payment.count({ where: { userId: user.id, studioId } }),
    prisma.attendance.count({ where: { userId: user.id } }),
    prisma.waitlistEntry.count({ where: { userId: user.id } }),
    prisma.qRToken.count({ where: { userId: user.id } }),
    prisma.refreshToken.count({ where: { userId: user.id } }),
    prisma.buildJob.count({ where: { requestedByUserId: user.id } }),
  ]);

  const counts = {
    bookingCount,
    subscriptionCount,
    paymentCount,
    attendanceCount,
    waitlistCount,
    qrTokenCount,
    refreshTokenCount,
    buildJobCount,
  };

  // Step 4a: hard safety gate — business data that blocks regardless of refresh tokens.
  // RefreshTokens are intentionally excluded here; they are handled separately below.
  const hasHardBlockingData =
    bookingCount > 0 ||
    subscriptionCount > 0 ||
    paymentCount > 0 ||
    attendanceCount > 0 ||
    waitlistCount > 0 ||
    qrTokenCount > 0 ||
    buildJobCount > 0;

  if (hasHardBlockingData) {
    gate(
      `${email} has business data — StudioMembership NOT touched.\n` +
        `       bookings=${bookingCount}  subs=${subscriptionCount}  payments=${paymentCount}` +
        `  attendance=${attendanceCount}  waitlist=${waitlistCount}\n` +
        `       qrTokens=${qrTokenCount}  buildJobs=${buildJobCount}` +
        `  (refreshTokens=${refreshTokenCount} noted but not the blocker)`,
    );
    return {
      ...emptyResult({ userId: user.id, userFound: true, membershipFound: true }),
      ...counts,
      refreshTokensDeleted: 0,
      action: 'DO_NOT_DELETE',
    };
  }

  // Step 4b: refresh tokens are operational data (any login creates them).
  // Delete them first so the membership soft-delete is unblocked.
  let refreshTokensDeleted = 0;
  if (refreshTokenCount > 0) {
    write(
      'DELETE',
      'RefreshToken',
      `${email} — delete ${refreshTokenCount} operational token(s) before membership soft-delete`,
    );
    if (!DRY_RUN) {
      const { count } = await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
      refreshTokensDeleted = count;
    } else {
      refreshTokensDeleted = refreshTokenCount; // dry-run: report what would be deleted
    }
  }

  // Step 5: safe — soft-delete only the StudioMembership row. User is never touched.
  write(
    'SOFT_DEL',
    'StudioMembership',
    `${email} — role=${membership.role}, set deleted_at = now (User record untouched)`,
  );
  if (!DRY_RUN) {
    await prisma.studioMembership.update({
      where: { id: membership.id },
      data: { deletedAt: now },
    });
  }

  return {
    ...emptyResult({ userId: user.id, userFound: true, membershipFound: true }),
    ...counts,
    refreshTokensDeleted,
    action: 'SOFT_DELETE',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date();

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  ARES DEMO CLEANUP SCRIPT');
  console.log(`  Studio : ${ARES_SLUG}`);
  console.log(`  Mode   : ${DRY_RUN ? 'DRY_RUN — zero writes' : 'LIVE_RUN — WRITES ACTIVE'}`);
  console.log(`  Run at : ${now.toISOString()}`);
  console.log('════════════════════════════════════════════════════════════════');

  if (!DRY_RUN) {
    console.log('');
    console.log('  LIVE_RUN=true is set. Writes are active. There is no undo.');
    console.log('  The following are NEVER touched by this script:');
    console.log('    Bookings | Attendance | WaitlistEntries | Payments | Subscriptions | Users');
  }

  const studio = await prisma.studio.findUniqueOrThrow({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true },
  });
  console.log(`\n  Studio confirmed: ${studio.name}  (${studio.id})\n`);

  // ── 1. Class templates ───────────────────────────────────────────────────

  section('CLASS TEMPLATES — cancel future classes + soft-delete');
  const templateResults: TemplateResult[] = [];

  for (const name of DEMO_TEMPLATE_NAMES) {
    templateResults.push(await processTemplate(studio.id, name, now));
  }

  // ── 2. Plans: soft-delete (Unlimited Strength + Flex 8) ─────────────────

  section('MEMBERSHIP PLANS — soft-delete (subscriptions kept intact)');
  const planResults: PlanResult[] = [];

  for (const name of SOFT_DELETE_PLAN_NAMES) {
    planResults.push(await softDeletePlan(studio.id, name, now));
  }

  // ── 3. TURBO: runtime-verified ───────────────────────────────────────────

  section('MEMBERSHIP PLAN — TURBO (runtime-verified)');
  planResults.push(await processTurbo(studio.id, now));

  // ── 4. Demo staff memberships ────────────────────────────────────────────

  section('DEMO STAFF — soft-delete StudioMembership (User record never deleted)');
  const staffResults: StaffMembershipResult[] = [];

  // Always-skip list: emails that have confirmed blocking business data and
  // must not be touched until resolved separately.
  for (const email of STAFF_ALWAYS_SKIP) {
    skip('StudioMembership', `${email} — explicitly excluded (bookings=4, buildJobs=24; resolve manually)`);
    staffResults.push({
      email, userId: null, userFound: false, membershipFound: false, alreadySoftDeleted: false,
      bookingCount: 0, subscriptionCount: 0, paymentCount: 0, attendanceCount: 0,
      waitlistCount: 0, qrTokenCount: 0, refreshTokenCount: 0, buildJobCount: 0,
      refreshTokensDeleted: 0, action: 'SKIP',
    });
  }

  for (const email of DEMO_STAFF_EMAILS) {
    staffResults.push(await processStaffMembership(studio.id, email, now));
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  ${DRY_RUN ? 'DRY_RUN' : 'LIVE_RUN'} SUMMARY`);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');

  let totalFutureCancelled = 0;
  let totalTemplateSoftDeleted = 0;
  let totalPlanSoftDeleted = 0;
  let totalPlanHardDeleted = 0;
  let totalMembershipSoftDeleted = 0;
  let totalMembershipBlocked = 0;
  let totalRefreshTokensDeleted = 0;

  for (const r of templateResults) {
    const note = !r.found ? 'skipped (not found)' : r.action === 'SOFT_DELETE' ? 'soft-deleted' : 'skipped';
    console.log(`  ClassTemplate  "${r.name}" — ${note}`);
    if (r.action === 'SOFT_DELETE') {
      totalTemplateSoftDeleted++;
      totalFutureCancelled += r.futureCancelledCount;
    }
  }

  for (const r of planResults) {
    const note = !r.found
      ? 'skipped (not found)'
      : r.action === 'HARD_DELETE'
      ? 'hard-deleted'
      : r.action === 'SOFT_DELETE'
      ? `soft-deleted${r.realStripeCount > 0 ? ` (${r.realStripeCount} real Stripe sub(s) kept)` : ''}`
      : 'skipped';
    console.log(`  MembershipPlan "${r.name}" — ${note}`);
    if (r.action === 'SOFT_DELETE') totalPlanSoftDeleted++;
    if (r.action === 'HARD_DELETE') totalPlanHardDeleted++;
  }

  for (const r of staffResults) {
    const note = !r.userFound
      ? 'skipped (user not found)'
      : !r.membershipFound
      ? 'skipped (no membership)'
      : r.alreadySoftDeleted
      ? 'skipped (already soft-deleted)'
      : r.action === 'SOFT_DELETE'
      ? 'StudioMembership soft-deleted'
      : r.action === 'DO_NOT_DELETE'
      ? 'BLOCKED — has attached data'
      : 'skipped';
    console.log(`  Staff          ${r.email} — ${note}`);
    if (r.action === 'SOFT_DELETE') totalMembershipSoftDeleted++;
    if (r.action === 'DO_NOT_DELETE') totalMembershipBlocked++;
    totalRefreshTokensDeleted += r.refreshTokensDeleted;
  }

  console.log('');
  console.log(`  Future scheduled classes cancelled   : ${totalFutureCancelled}`);
  console.log(`  Class templates soft-deleted         : ${totalTemplateSoftDeleted}`);
  console.log(`  Membership plans soft-deleted        : ${totalPlanSoftDeleted}`);
  console.log(`  Membership plans hard-deleted        : ${totalPlanHardDeleted}`);
  console.log(`  Staff memberships soft-deleted       : ${totalMembershipSoftDeleted}`);
  console.log(`  Staff memberships blocked (DO_NOT)   : ${totalMembershipBlocked}`);
  console.log(`  Refresh tokens deleted (operational) : ${totalRefreshTokensDeleted}`);
  console.log('');
  console.log('  Records never touched:');
  console.log('    Users:         0 deleted');
  console.log('    Bookings:      0 deleted  (future class bookings preserved as-is)');
  console.log('    Attendance:    0 deleted');
  console.log('    WaitlistEntries: 0 deleted');
  console.log('    Subscriptions: 0 deleted');
  console.log('    Payments:      0 deleted');

  if (totalMembershipBlocked > 0) {
    console.log('');
    console.log(`  !! ${totalMembershipBlocked} staff membership(s) were blocked by safety gate.`);
    console.log('     Review the GATE output above and investigate before retrying.');
  }

  console.log('');
  if (DRY_RUN) {
    console.log('  DRY_RUN complete — no data was modified.');
    console.log('  Re-run with LIVE_RUN=true to apply all changes above.');
  } else {
    console.log('  LIVE_RUN complete.');
  }

  // ── JSON output ───────────────────────────────────────────────────────────

  const fill = '─'.repeat(60);
  console.log(`\n── JSON SUMMARY ${fill}`);
  console.log(
    JSON.stringify(
      {
        event: 'cleanup_ares_demo',
        studio: ARES_SLUG,
        dryRun: DRY_RUN,
        runAt: now.toISOString(),
        templates: templateResults,
        plans: planResults,
        staffMemberships: staffResults,
        totals: {
          futureScheduledClassesCancelled: totalFutureCancelled,
          templatesSoftDeleted: totalTemplateSoftDeleted,
          plansSoftDeleted: totalPlanSoftDeleted,
          plansHardDeleted: totalPlanHardDeleted,
          staffMembershipsSoftDeleted: totalMembershipSoftDeleted,
          staffMembershipsBlocked: totalMembershipBlocked,
          refreshTokensDeleted: totalRefreshTokensDeleted,
          usersDeleted: 0,
          bookingsDeleted: 0,
          attendanceDeleted: 0,
          waitlistDeleted: 0,
          subscriptionsDeleted: 0,
          paymentsDeleted: 0,
        },
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
