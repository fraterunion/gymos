/**
 * MM-4 stage E — make Booty Lab stackable (ARES), with an explicit, audited
 * re-classification of the LIVE existing Booty subscription snapshots.
 *
 *   MembershipPlan.exclusiveGroup:      'CORE' -> NULL
 *   Subscription.exclusiveGroupKey:     'CORE' -> NULL   (live/relevant rows only)
 *
 * Scope of the snapshot re-classification (exactly):
 *   membershipPlanId = Booty Lab
 *   AND exclusiveGroupKey = 'CORE'
 *   AND ( status IN (ACTIVE, TRIALING, PAST_DUE, PAUSED, SCHEDULED)
 *         OR (status = CANCELED AND entitlementEndsAt > now()) )
 * Fully-ended historical rows are NEVER rewritten — they keep the CORE snapshot they
 * were sold under. No Stripe calls, no payment changes, no entitlement-window changes,
 * no status changes. Idempotent: a second --execute reports nothing to change.
 *
 * Usage (DRY RUN is the default; nothing is written without --execute):
 *   npx tsx scripts/mm4-booty-stackable.ts                 # dry run (forward)
 *   npx tsx scripts/mm4-booty-stackable.ts --execute       # forward: CORE -> NULL
 *   npx tsx scripts/mm4-booty-stackable.ts --reverse       # dry run (reverse)
 *   npx tsx scripts/mm4-booty-stackable.ts --reverse --execute  # NULL -> CORE (pre-dual only)
 *
 * The reverse operation is ONLY valid before any legitimate stacked pair involving Booty
 * exists — it asserts that and aborts otherwise. Never run automatically.
 */
import { PrismaClient, Prisma, SubscriptionStatus } from '@prisma/client';

export const ARES_STUDIO_ID = 'cmp33m0gp0000qomlj9p42ia5';
/** Exact ARES "Booty Lab by Etzia" plan id (from the repo's production audits). */
export const ARES_BOOTY_PLAN_ID = 'cmsy7ns48002fqm1xda3z0xd7';

const RENEWABLE = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.TRIALING,
  SubscriptionStatus.PAST_DUE,
  SubscriptionStatus.PAUSED,
] as const;
const LIVE_STATUSES = [...RENEWABLE, SubscriptionStatus.SCHEDULED] as const;

export type BootyStackableOptions = {
  studioId?: string;
  planId?: string;
  execute?: boolean;
  log?: (line: string) => void;
};

type Tx = Prisma.TransactionClient;

function scopedRowsWhere(
  studioId: string,
  planId: string,
  fromKey: string | null,
  now: Date,
): Prisma.SubscriptionWhereInput {
  return {
    studioId,
    membershipPlanId: planId,
    exclusiveGroupKey: fromKey,
    OR: [
      { status: { in: [...LIVE_STATUSES] } },
      { status: SubscriptionStatus.CANCELED, entitlementEndsAt: { gt: now } },
    ],
  };
}

async function loadAndAssertPlan(
  db: PrismaClient | Tx,
  studioId: string,
  planId: string,
): Promise<{ id: string; name: string; exclusiveGroup: string | null }> {
  const plan = await db.membershipPlan.findFirst({
    where: { id: planId, studioId, deletedAt: null },
    select: { id: true, name: true, exclusiveGroup: true },
  });
  if (!plan) {
    throw new Error(`Plan ${planId} not found in studio ${studioId}`);
  }
  if (!/booty/i.test(plan.name)) {
    throw new Error(
      `Refusing to operate: plan ${plan.id} is named "${plan.name}" — expected the Booty Lab plan`,
    );
  }
  return plan;
}

function printRows(
  log: (line: string) => void,
  rows: Array<{
    id: string;
    status: SubscriptionStatus;
    source: string;
    entitlementEndsAt: Date | null;
    exclusiveGroupKey: string | null;
  }>,
  afterKey: string | null,
): void {
  for (const r of rows) {
    log(
      `  ${r.id}  status=${r.status}  source=${r.source}  entitlementEndsAt=${
        r.entitlementEndsAt?.toISOString() ?? 'null'
      }  exclusiveGroupKey: ${JSON.stringify(r.exclusiveGroupKey)} -> ${JSON.stringify(afterKey)}`,
    );
  }
}

/** Forward: plan CORE -> NULL and live Booty snapshots CORE -> NULL. */
export async function runBootyStackable(
  prisma: PrismaClient,
  options: BootyStackableOptions = {},
): Promise<{ changedRowIds: string[]; planChanged: boolean }> {
  const studioId = options.studioId ?? ARES_STUDIO_ID;
  const planId = options.planId ?? ARES_BOOTY_PLAN_ID;
  const execute = options.execute ?? false;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = new Date();

  const plan = await loadAndAssertPlan(prisma, studioId, planId);
  log(`MM-4 Booty stackable (${execute ? 'EXECUTE' : 'DRY RUN'})`);
  log(`plan: ${plan.id} "${plan.name}"  exclusiveGroup=${JSON.stringify(plan.exclusiveGroup)}`);

  const rows = await prisma.subscription.findMany({
    where: scopedRowsWhere(studioId, planId, 'CORE', now),
    select: { id: true, status: true, source: true, entitlementEndsAt: true, exclusiveGroupKey: true },
    orderBy: { createdAt: 'asc' },
  });
  const planNeedsChange = plan.exclusiveGroup !== null;
  log(`rows to reclassify (snapshot CORE -> NULL): ${rows.length}`);
  printRows(log, rows, null);
  log(`plan exclusiveGroup change needed: ${planNeedsChange ? "'CORE' -> NULL" : 'no (already NULL)'}`);

  if (!execute) {
    log('DRY RUN — nothing written.');
    return { changedRowIds: rows.map((r) => r.id), planChanged: false };
  }

  if (!planNeedsChange && rows.length === 0) {
    log('Nothing to change — already executed (idempotent no-op).');
    return { changedRowIds: [], planChanged: false };
  }

  const changedRowIds = await prisma.$transaction(async (tx) => {
    // Lock the scoped rows, then re-verify the exact expected state under the lock.
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx.$queryRaw`SELECT id FROM "subscriptions" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
    }
    const verified = await tx.subscription.findMany({
      where: { id: { in: ids }, ...scopedRowsWhere(studioId, planId, 'CORE', now) },
      select: { id: true },
    });
    if (verified.length !== ids.length) {
      throw new Error(
        `State changed under us: expected ${ids.length} scoped rows, found ${verified.length} — aborting (re-run to re-evaluate)`,
      );
    }

    const lockedPlan = await loadAndAssertPlan(tx, studioId, planId);
    if (lockedPlan.exclusiveGroup !== null) {
      await tx.membershipPlan.update({
        where: { id: planId },
        data: { exclusiveGroup: null },
      });
    }
    if (ids.length > 0) {
      await tx.subscription.updateMany({
        where: { id: { in: ids } },
        data: { exclusiveGroupKey: null },
      });
    }

    await tx.auditLog.create({
      data: {
        studioId,
        actorUserId: null,
        action: 'MM4_BOOTY_STACKABLE_EXECUTED',
        entityType: 'MembershipPlan',
        entityId: planId,
        metadata: {
          planExclusiveGroup: { before: lockedPlan.exclusiveGroup, after: null },
          snapshotChange: { before: 'CORE', after: null },
          subscriptionIds: ids,
          rowCount: ids.length,
          scopeStatuses: [...LIVE_STATUSES, 'CANCELED-but-entitled'],
        },
      },
    });
    return ids;
  });

  const remaining = await prisma.subscription.count({
    where: scopedRowsWhere(studioId, planId, 'CORE', now),
  });
  const planAfter = await prisma.membershipPlan.findUniqueOrThrow({
    where: { id: planId },
    select: { exclusiveGroup: true },
  });
  log(`verification: plan exclusiveGroup=${JSON.stringify(planAfter.exclusiveGroup)}; scoped CORE rows remaining=${remaining}`);
  if (planAfter.exclusiveGroup !== null || remaining !== 0) {
    throw new Error('Post-execution verification failed');
  }
  log(`EXECUTED — ${changedRowIds.length} subscription snapshot(s) reclassified.`);
  return { changedRowIds, planChanged: true };
}

/**
 * Reverse (pre-dual rollback ONLY): plan NULL -> CORE and live Booty snapshots
 * NULL -> CORE. Aborts if any member already holds a Booty renewable membership
 * alongside another renewable membership (a legitimate stacked pair).
 */
export async function runBootyStackableReverse(
  prisma: PrismaClient,
  options: BootyStackableOptions = {},
): Promise<{ changedRowIds: string[]; planChanged: boolean }> {
  const studioId = options.studioId ?? ARES_STUDIO_ID;
  const planId = options.planId ?? ARES_BOOTY_PLAN_ID;
  const execute = options.execute ?? false;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = new Date();

  const plan = await loadAndAssertPlan(prisma, studioId, planId);
  log(`MM-4 Booty stackable REVERSE (${execute ? 'EXECUTE' : 'DRY RUN'})`);
  log(`plan: ${plan.id} "${plan.name}"  exclusiveGroup=${JSON.stringify(plan.exclusiveGroup)}`);

  // Point-of-no-return guard: any member with a renewable Booty row AND any other
  // renewable row already relies on stackability — reversing would strand them.
  const bootyRenewable = await prisma.subscription.findMany({
    where: { studioId, membershipPlanId: planId, status: { in: [...RENEWABLE] } },
    select: { id: true, userId: true },
  });
  const dualHolders: string[] = [];
  for (const row of bootyRenewable) {
    const siblings = await prisma.subscription.count({
      where: {
        studioId,
        userId: row.userId,
        status: { in: [...RENEWABLE] },
        membershipPlanId: { not: planId },
      },
    });
    if (siblings > 0) dualHolders.push(row.userId);
  }
  if (dualHolders.length > 0) {
    throw new Error(
      `REVERSE blocked: ${dualHolders.length} member(s) already hold Booty alongside another renewable membership — manual remediation required first (userIds: ${dualHolders.join(', ')})`,
    );
  }

  const rows = await prisma.subscription.findMany({
    where: scopedRowsWhere(studioId, planId, null, now),
    select: { id: true, status: true, source: true, entitlementEndsAt: true, exclusiveGroupKey: true },
    orderBy: { createdAt: 'asc' },
  });
  const planNeedsChange = plan.exclusiveGroup === null;
  log(`rows to reclassify (snapshot NULL -> CORE): ${rows.length}`);
  printRows(log, rows, 'CORE');
  log(`plan exclusiveGroup change needed: ${planNeedsChange ? "NULL -> 'CORE'" : 'no (already CORE)'}`);

  if (!execute) {
    log('DRY RUN — nothing written.');
    return { changedRowIds: rows.map((r) => r.id), planChanged: false };
  }

  if (!planNeedsChange && rows.length === 0) {
    log('Nothing to change — already reversed (idempotent no-op).');
    return { changedRowIds: [], planChanged: false };
  }

  const changedRowIds = await prisma.$transaction(async (tx) => {
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await tx.$queryRaw`SELECT id FROM "subscriptions" WHERE id IN (${Prisma.join(ids)}) FOR UPDATE`;
    }
    const verified = await tx.subscription.findMany({
      where: { id: { in: ids }, ...scopedRowsWhere(studioId, planId, null, now) },
      select: { id: true },
    });
    if (verified.length !== ids.length) {
      throw new Error('State changed under us — aborting reverse (re-run to re-evaluate)');
    }
    const lockedPlan = await loadAndAssertPlan(tx, studioId, planId);
    if (lockedPlan.exclusiveGroup === null) {
      await tx.membershipPlan.update({ where: { id: planId }, data: { exclusiveGroup: 'CORE' } });
    }
    if (ids.length > 0) {
      await tx.subscription.updateMany({
        where: { id: { in: ids } },
        data: { exclusiveGroupKey: 'CORE' },
      });
    }
    await tx.auditLog.create({
      data: {
        studioId,
        actorUserId: null,
        action: 'MM4_BOOTY_STACKABLE_REVERSED',
        entityType: 'MembershipPlan',
        entityId: planId,
        metadata: {
          planExclusiveGroup: { before: lockedPlan.exclusiveGroup, after: 'CORE' },
          snapshotChange: { before: null, after: 'CORE' },
          subscriptionIds: ids,
          rowCount: ids.length,
        },
      },
    });
    return ids;
  });

  log(`REVERSED — ${changedRowIds.length} subscription snapshot(s) restored to CORE.`);
  return { changedRowIds, planChanged: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const reverse = args.includes('--reverse');
  const unknown = args.filter((a) => !['--execute', '--dry-run', '--reverse'].includes(a));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(' ')}`);
  }
  const prisma = new PrismaClient();
  try {
    if (reverse) {
      await runBootyStackableReverse(prisma, { execute });
    } else {
      await runBootyStackable(prisma, { execute });
    }
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
