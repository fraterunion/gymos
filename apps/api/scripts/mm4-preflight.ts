/**
 * MM-4 constraint-swap preflight — READ-ONLY. Reports the exact conditions the
 * multi_membership_constraint_swap migration will assert (BLOCKING B1–B8) plus the
 * EXPECTED states that are healthy and must not block (transition pairs, overlapping
 * fixed-duration entitled windows).
 *
 * Exit code: 1 if ANY blocking condition has rows; 0 otherwise. Performs no writes.
 *
 * Stripe-side checks (stripe_orphan / duplicate_renewable / requiresManualResolution)
 * require the live Stripe API and are NOT run here — run the admin reconciliation
 * report for the studio separately and require requiresManualResolution=false before
 * the swap.
 *
 * Usage: DATABASE_URL=... npx tsx scripts/mm4-preflight.ts
 */
import { PrismaClient } from '@prisma/client';

type Check = { id: string; label: string; sql: string };

const BLOCKING: Check[] = [
  {
    id: 'B1',
    label: 'duplicate renewable rows per member+plan',
    sql: `SELECT studio_id, user_id, membership_plan_id, COUNT(*) AS n, array_agg(id) AS ids
          FROM subscriptions
          WHERE status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')
          GROUP BY 1,2,3 HAVING COUNT(*) > 1`,
  },
  {
    id: 'B2',
    label: 'duplicate renewable rows per member+group',
    sql: `SELECT studio_id, user_id, exclusive_group_key, COUNT(*) AS n, array_agg(id) AS ids
          FROM subscriptions
          WHERE status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED') AND exclusive_group_key IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1`,
  },
  {
    id: 'B3',
    label: 'duplicate SCHEDULED rows per member+plan',
    sql: `SELECT studio_id, user_id, membership_plan_id, COUNT(*) AS n, array_agg(id) AS ids
          FROM subscriptions WHERE status = 'SCHEDULED'
          GROUP BY 1,2,3 HAVING COUNT(*) > 1`,
  },
  {
    id: 'B4',
    label: 'duplicate SCHEDULED rows per member+group',
    sql: `SELECT studio_id, user_id, exclusive_group_key, COUNT(*) AS n, array_agg(id) AS ids
          FROM subscriptions WHERE status = 'SCHEDULED' AND exclusive_group_key IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(*) > 1`,
  },
  {
    id: 'B5',
    label: 'live rows with NULL exclusive_group_key snapshot',
    sql: `SELECT id, studio_id, user_id, membership_plan_id, status FROM subscriptions
          WHERE status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED','SCHEDULED')
            AND exclusive_group_key IS NULL`,
  },
  {
    id: 'B6',
    label: 'live snapshot/plan exclusive_group mismatch (pre-Booty-stage this must be zero)',
    sql: `SELECT s.id, s.exclusive_group_key, mp.exclusive_group
          FROM subscriptions s JOIN membership_plans mp ON mp.id = s.membership_plan_id
          WHERE s.status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED','SCHEDULED')
            AND s.exclusive_group_key IS DISTINCT FROM mp.exclusive_group`,
  },
  {
    id: 'B7',
    label: 'STRIPE-source renewable rows missing stripe_subscription_id',
    sql: `SELECT id, studio_id, user_id, status FROM subscriptions
          WHERE source = 'STRIPE' AND stripe_subscription_id IS NULL
            AND status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED')`,
  },
  {
    id: 'B8',
    label: 'non-deleted plans with NULL exclusive_group (pre-Booty-stage this must be zero)',
    sql: `SELECT id, studio_id, name FROM membership_plans
          WHERE deleted_at IS NULL AND exclusive_group IS NULL`,
  },
];

const EXPECTED: Check[] = [
  {
    id: 'E1',
    label: 'renewable + SCHEDULED transition pairs per family (healthy Stripe→Cash state)',
    sql: `SELECT r.studio_id, r.user_id, r.membership_plan_id, r.id AS renewable_id, s.id AS scheduled_id
          FROM subscriptions r JOIN subscriptions s
            ON s.studio_id = r.studio_id AND s.user_id = r.user_id
           AND (s.membership_plan_id = r.membership_plan_id
                OR (s.exclusive_group_key IS NOT NULL AND s.exclusive_group_key = r.exclusive_group_key))
          WHERE r.status IN ('ACTIVE','TRIALING','PAST_DUE','PAUSED') AND s.status = 'SCHEDULED'`,
  },
  {
    id: 'E2',
    label: 'overlapping same-plan entitled windows (legacy-allowed fixed-duration artifact)',
    sql: `SELECT a.studio_id, a.user_id, a.membership_plan_id, a.id AS row_a, b.id AS row_b
          FROM subscriptions a JOIN subscriptions b
            ON a.studio_id = b.studio_id AND a.user_id = b.user_id
           AND a.membership_plan_id = b.membership_plan_id AND a.id < b.id
          WHERE a.entitlement_ends_at > now() AND b.entitlement_ends_at > now()
            AND a.status IN ('ACTIVE','TRIALING','CANCELED')
            AND b.status IN ('ACTIVE','TRIALING','CANCELED')`,
  },
];

export async function runPreflight(
  prisma: PrismaClient,
  log: (line: string) => void = (line) => console.log(line),
): Promise<{ blocking: number }> {
  let blocking = 0;
  log('MM-4 constraint-swap preflight (READ-ONLY)');
  log('');
  log('── BLOCKING checks (any rows abort the swap) ──');
  for (const check of BLOCKING) {
    const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown[];
    const status = rows.length === 0 ? 'OK' : `BLOCKING (${rows.length} row(s))`;
    log(`${check.id} ${check.label}: ${status}`);
    if (rows.length > 0) {
      blocking += rows.length;
      for (const row of rows.slice(0, 20)) {
        log(`    ${JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))}`);
      }
      if (rows.length > 20) log(`    … and ${rows.length - 20} more`);
    }
  }
  log('');
  log('── EXPECTED states (reported, never blocking) ──');
  for (const check of EXPECTED) {
    const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown[];
    log(`${check.id} ${check.label}: ${rows.length} row(s)`);
  }
  log('');
  log('── Stripe-side (not covered here) ──');
  log('Run the studio reconciliation report and require: 0 stripe_orphan involving');
  log('renewable subs, 0 duplicate_renewable, requiresManualResolution=false.');
  log('');
  log(blocking === 0 ? 'RESULT: CLEAR — no blocking conditions.' : `RESULT: ${blocking} BLOCKING row(s) — DO NOT run the swap.`);
  return { blocking };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const { blocking } = await runPreflight(prisma);
    if (blocking > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
