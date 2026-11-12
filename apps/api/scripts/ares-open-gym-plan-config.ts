/**
 * ARES Open Gym plan configuration — the ONE production data change for the Open Gym
 * entitlement fix. DRY-RUN BY DEFAULT; writes nothing unless explicitly applied.
 *
 * Target state (business rule: only Full Access includes Open Gym):
 *   Full Access  cmq1y1snv000vensw5atqx03l  openGymAccess = true,  no window   (verify only)
 *   Basic Access cmq1y1sqe000xenswkzsfwq28  openGymAccess = false, no window   (CHANGE)
 *   Pro          cmqzn1r95003zqo0rh16v6nbf  openGymAccess = false, no window   (verify only)
 *
 * Exactly one row can change: Basic Access, from (true, 11:00, 22:00) — the value migration
 * 20260822200000_open_gym_facility_access wrote — to (false, NULL, NULL). The update is guarded
 * by the full expected pre-state in its WHERE clause, so if anyone has touched the row since the
 * audit, it matches zero rows and the script aborts instead of overwriting.
 *
 * Never touched: prices, Stripe ids, class access, subscriptions, bookings, attendance, any
 * other plan, any other studio. The separate "Open Gym" plan (cmr3z8ml30015m60rnzivemyf) is a
 * product decision outside this rule and is reported, not changed.
 *
 * Usage (production vars via Railway):
 *   railway run --service api npx tsx scripts/ares-open-gym-plan-config.ts            # dry run
 *   ARES_OPEN_GYM_APPLY=cmq1y1sqe000xenswkzsfwq28 ARES_OPEN_GYM_ACTOR_USER_ID=<owner id> \
 *     railway run --service api npx tsx scripts/ares-open-gym-plan-config.ts --apply  # write
 *
 * Applying requires BOTH the --apply flag and ARES_OPEN_GYM_APPLY set to the Basic Access plan
 * id, so it cannot happen by accident. The change and an AuditLog row (MEMBERSHIP_PLAN_UPDATED,
 * same shape the Admin editor writes) commit in one transaction. Rollback: the inverse values
 * (true, '11:00', '22:00') via the Admin plan editor.
 *
 * Output is aggregate-only: plan ids/names, flags and counts. No member data.
 */
import { PrismaClient } from '@prisma/client';

const STUDIO_ID = 'cmp33m0gp0000qomlj9p42ia5';
const PLANS = {
  full: { id: 'cmq1y1snv000vensw5atqx03l', name: 'Full Access', expect: { openGymAccess: true } },
  basic: { id: 'cmq1y1sqe000xenswkzsfwq28', name: 'Basic Access', expect: { openGymAccess: false } },
  pro: { id: 'cmqzn1r95003zqo0rh16v6nbf', name: 'Pro', expect: { openGymAccess: false } },
} as const;
const OPEN_GYM_PLAN_ID = 'cmr3z8ml30015m60rnzivemyf';
const BASIC_PRE_STATE = { openGymAccess: true, openGymWindowStart: '11:00', openGymWindowEnd: '22:00' };

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();
  try {
    const plans = await prisma.membershipPlan.findMany({
      where: { studioId: STUDIO_ID, id: { in: [...Object.values(PLANS).map((p) => p.id), OPEN_GYM_PLAN_ID] } },
      select: { id: true, name: true, deletedAt: true, active: true, openGymAccess: true, openGymWindowStart: true, openGymWindowEnd: true },
    });
    const byId = new Map(plans.map((p) => [p.id, p]));

    let basicNeedsChange = false;
    for (const [key, target] of Object.entries(PLANS)) {
      const row = byId.get(target.id);
      if (!row || row.name !== target.name || row.deletedAt) {
        throw new Error(`ABORT: ${key} plan ${target.id} missing, renamed or deleted (found ${row?.name ?? 'none'})`);
      }
      const ok = row.openGymAccess === target.expect.openGymAccess && row.openGymWindowStart === null && row.openGymWindowEnd === null;
      console.log(
        `${target.name.padEnd(13)} ${target.id}  openGymAccess=${row.openGymAccess} window=${row.openGymWindowStart ?? '-'}..${row.openGymWindowEnd ?? '-'}  ${ok ? 'OK' : 'NEEDS CHANGE'}`,
      );
      if (!ok && key !== 'basic') {
        throw new Error(`ABORT: ${target.name} is not in its expected state; this script only changes Basic Access.`);
      }
      if (!ok && key === 'basic') basicNeedsChange = true;
    }
    const og = byId.get(OPEN_GYM_PLAN_ID);
    console.log(
      `(not changed) Open Gym plan ${OPEN_GYM_PLAN_ID}: openGymAccess=${og?.openGymAccess} window=${og?.openGymWindowStart ?? '-'}..${og?.openGymWindowEnd ?? '-'}`,
    );

    if (!basicNeedsChange) {
      console.log('\nNothing to do: production already matches the target configuration.');
      return;
    }

    const basic = byId.get(PLANS.basic.id)!;
    if (
      basic.openGymAccess !== BASIC_PRE_STATE.openGymAccess ||
      basic.openGymWindowStart !== BASIC_PRE_STATE.openGymWindowStart ||
      basic.openGymWindowEnd !== BASIC_PRE_STATE.openGymWindowEnd
    ) {
      throw new Error('ABORT: Basic Access differs from the audited pre-state (true, 11:00, 22:00); re-audit before changing.');
    }

    console.log('\nPlanned change: Basic Access openGymAccess true -> false, window 11:00..22:00 -> none.');
    if (!apply) {
      console.log('DRY RUN — nothing written. Re-run with --apply and ARES_OPEN_GYM_APPLY to execute.');
      return;
    }
    if (process.env.ARES_OPEN_GYM_APPLY !== PLANS.basic.id) {
      throw new Error(`ABORT: --apply requires ARES_OPEN_GYM_APPLY=${PLANS.basic.id}`);
    }
    const actorUserId = process.env.ARES_OPEN_GYM_ACTOR_USER_ID?.trim() || null;

    await prisma.$transaction(async (tx) => {
      const res = await tx.membershipPlan.updateMany({
        where: { id: PLANS.basic.id, studioId: STUDIO_ID, deletedAt: null, ...BASIC_PRE_STATE },
        data: { openGymAccess: false, openGymWindowStart: null, openGymWindowEnd: null },
      });
      if (res.count !== 1) {
        throw new Error(`ABORT: guarded update matched ${res.count} rows (expected 1); rolled back.`);
      }
      await tx.auditLog.create({
        data: {
          studioId: STUDIO_ID,
          actorUserId,
          action: 'MEMBERSHIP_PLAN_UPDATED',
          entityType: 'membership_plan',
          entityId: PLANS.basic.id,
          metadata: {
            planName: PLANS.basic.name,
            source: 'scripts/ares-open-gym-plan-config.ts',
            reason: 'Business rule: only Full Access includes Open Gym',
            changes: {
              openGymAccess: { from: true, to: false },
              openGymWindowStart: { from: '11:00', to: null },
              openGymWindowEnd: { from: '22:00', to: null },
            },
          },
        },
      });
    });
    console.log('APPLIED: Basic Access no longer includes Open Gym. Audit row written.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
