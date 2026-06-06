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
 *
 * What this script NEVER does:
 *   Delete or modify Bookings, Attendance, WaitlistEntries, or Payments.
 *   Delete Subscriptions (real Stripe or demo).
 *   Touch any studio other than ares-fitness.
 *   Touch the ARES real coaches or real membership plans.
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

// ─── Template: cancel future classes + soft-delete ────────────────────────────

async function processTemplate(
  studioId: string,
  name: string,
  now: Date,
): Promise<TemplateResult> {
  // Only target non-deleted templates — idempotent on re-run
  const template = await prisma.classTemplate.findFirst({
    where: { studioId, name, deletedAt: null },
    select: { id: true },
  });

  if (!template) {
    skip('ClassTemplate', `"${name}" — not found or already soft-deleted`);
    return { name, found: false, futureCancelledCount: 0, action: 'SKIP' };
  }

  // Count future non-cancelled scheduled classes at runtime
  const futureCount = await prisma.scheduledClass.count({
    where: {
      studioId,
      classTemplateId: template.id,
      startsAt: { gt: now },
      status: { not: ClassStatus.CANCELLED },
    },
  });

  // Step 1: Cancel future scheduled classes
  // Bookings, waitlist, and attendance on these classes are intentionally preserved.
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
      data: {
        status: ClassStatus.CANCELLED,
        cancelReason: CANCEL_REASON,
      },
    });
  }

  // Step 2: Soft-delete the template — preserves all FK references (ScheduledClass,
  // Booking, Attendance, WaitlistEntry) via their own foreign keys.
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

  // Runtime count — logged only; does NOT gate the soft-delete.
  // Subscriptions referencing this plan survive the soft-delete via FK.
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

  // Re-verify at runtime — diagnostic output may be stale
  const [subscriptionCount, paymentCount] = await Promise.all([
    prisma.subscription.count({ where: { membershipPlanId: plan.id } }),
    prisma.payment.count({ where: { membershipPlanId: plan.id } }),
  ]);

  if (subscriptionCount > 0 || paymentCount > 0) {
    // Conditions changed since diagnostic — fall back to soft-delete
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

  // Gate passed: 0 subscriptions (RESTRICT FK clear) and 0 payments (SetNull FK auto-handles)
  write(
    'DELETE',
    'MembershipPlan',
    '"TURBO" — hard delete (runtime confirmed: 0 subs, 0 payments)',
  );
  if (!DRY_RUN) {
    await prisma.membershipPlan.delete({ where: { id: plan.id } });
  }

  return { name: 'TURBO', found: true, action: 'HARD_DELETE', subscriptionCount: 0, realStripeCount: 0 };
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
    console.log('    Bookings | Attendance | WaitlistEntries | Payments | Subscriptions');
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

  console.log('');
  console.log(`  Future scheduled classes cancelled : ${totalFutureCancelled}`);
  console.log(`  Class templates soft-deleted       : ${totalTemplateSoftDeleted}`);
  console.log(`  Membership plans soft-deleted      : ${totalPlanSoftDeleted}`);
  console.log(`  Membership plans hard-deleted      : ${totalPlanHardDeleted}`);
  console.log('');
  console.log('  Records never touched:');
  console.log('    Bookings:      0 deleted  (future class bookings preserved as-is)');
  console.log('    Attendance:    0 deleted');
  console.log('    WaitlistEntries: 0 deleted');
  console.log('    Subscriptions: 0 deleted');
  console.log('    Payments:      0 deleted');

  console.log('');
  if (DRY_RUN) {
    console.log('  DRY_RUN complete — no data was modified.');
    console.log('  Re-run with LIVE_RUN=true to apply all changes above.');
  } else {
    console.log('  LIVE_RUN complete.');
  }

  // ── JSON output ───────────────────────────────────────────────────────────

  console.log('');
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
        totals: {
          futureScheduledClassesCancelled: totalFutureCancelled,
          templatesSoftDeleted: totalTemplateSoftDeleted,
          plansSoftDeleted: totalPlanSoftDeleted,
          plansHardDeleted: totalPlanHardDeleted,
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
