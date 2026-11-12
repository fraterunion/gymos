/**
 * READ-ONLY / DRY-RUN audit for ARES Full Access grandfathering after catalog
 * rose from MXN 1,500 → MXN 1,700 (FUTURE_ONLY, 2026-11-11).
 *
 * Usage (production vars via Railway, no writes):
 *   railway run --service api npx tsx scripts/ares-full-access-price-lock-audit.ts
 *
 * Optional APPLY is intentionally unsupported: subscription locks are already
 * correct in production. This script never mutates DB or Stripe.
 *
 * Output is aggregate-only (counts + subscriptionIds). It never prints emails,
 * names, phones, or userIds — safe for shared CI / application log capture.
 */
import { PrismaClient } from '@prisma/client';

const STUDIO_ID = process.env.ARES_STUDIO_ID ?? 'cmp33m0gp0000qomlj9p42ia5';
const FULL_ACCESS_PLAN_ID =
  process.env.ARES_FULL_ACCESS_PLAN_ID ?? 'cmq1y1snv000vensw5atqx03l';
const EXPECTED_LEGACY_CENTS = 150_000;
const EXPECTED_CATALOG_CENTS = 170_000;
const CUTOFF_ISO = '2026-11-11T22:56:10.884Z';

type Finding = {
  severity: 'ok' | 'review' | 'danger';
  code: string;
  detail: string;
  subscriptionId?: string;
};

async function main() {
  const prisma = new PrismaClient();
  const findings: Finding[] = [];

  try {
    const plan = await prisma.membershipPlan.findFirst({
      where: { id: FULL_ACCESS_PLAN_ID, studioId: STUDIO_ID },
      select: { id: true, priceCents: true },
    });
    if (!plan) {
      throw new Error(`Full Access plan not found: ${FULL_ACCESS_PLAN_ID}`);
    }

    if (plan.priceCents !== EXPECTED_CATALOG_CENTS) {
      findings.push({
        severity: 'review',
        code: 'CATALOG_UNEXPECTED',
        detail: `Catalog price is ${plan.priceCents}, expected ${EXPECTED_CATALOG_CENTS}`,
      });
    } else {
      findings.push({
        severity: 'ok',
        code: 'CATALOG_OK',
        detail: `Catalog Full Access is MXN ${EXPECTED_CATALOG_CENTS / 100} for new sales`,
      });
    }

    const change = await prisma.membershipPriceChange.findFirst({
      where: {
        studioId: STUDIO_ID,
        membershipPlanId: FULL_ACCESS_PLAN_ID,
        oldPriceCents: EXPECTED_LEGACY_CENTS,
        newPriceCents: EXPECTED_CATALOG_CENTS,
        scope: 'FUTURE_ONLY',
      },
      orderBy: { createdAt: 'desc' },
      include: { items: { select: { applyNewPrice: true, status: true } } },
    });

    if (!change) {
      findings.push({
        severity: 'danger',
        code: 'MISSING_FUTURE_ONLY_RUN',
        detail: 'No FUTURE_ONLY 1500→1700 membership_price_changes row found',
      });
    } else {
      const appliedNew = change.items.filter((i) => i.applyNewPrice && i.status === 'APPLIED');
      const skipped = change.items.filter((i) => !i.applyNewPrice);
      findings.push({
        severity: appliedNew.length === 0 ? 'ok' : 'danger',
        code: 'PRICE_CHANGE_SCOPE',
        detail: `Change ${change.id} status=${change.status} confirmed=${change.confirmedAt?.toISOString()} skipped=${skipped.length} appliedNew=${appliedNew.length}`,
      });
    }

    const active = await prisma.subscription.findMany({
      where: {
        studioId: STUDIO_ID,
        membershipPlanId: FULL_ACCESS_PLAN_ID,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'SCHEDULED'] },
      },
      select: {
        id: true,
        source: true,
        status: true,
        priceCents: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const shouldStay1500 = active.filter((s) => s.createdAt < new Date(CUTOFF_ISO));
    const afterCutoff = active.filter((s) => s.createdAt >= new Date(CUTOFF_ISO));

    let wrongLock = 0;
    let missingLock = 0;
    for (const s of shouldStay1500) {
      if (s.priceCents == null) {
        missingLock += 1;
        findings.push({
          severity: 'danger',
          code: 'LOCK_MISSING',
          subscriptionId: s.id,
          detail: 'Pre-cutoff Full Access row has null priceCents — renewals must not inherit catalog',
        });
      } else if (s.priceCents !== EXPECTED_LEGACY_CENTS) {
        wrongLock += 1;
        findings.push({
          severity: 'danger',
          code: 'LOCK_NOT_1500',
          subscriptionId: s.id,
          detail: `Expected lock ${EXPECTED_LEGACY_CENTS}, found ${s.priceCents}`,
        });
      }
    }

    for (const s of afterCutoff) {
      if (s.priceCents !== EXPECTED_CATALOG_CENTS) {
        findings.push({
          severity: 'review',
          code: 'POST_CUTOFF_NOT_1700',
          subscriptionId: s.id,
          detail: `Post-cutoff lock is ${s.priceCents}, expected catalog ${EXPECTED_CATALOG_CENTS}`,
        });
      }
    }

    const lockDist = await prisma.subscription.groupBy({
      by: ['priceCents', 'status', 'source'],
      where: {
        studioId: STUDIO_ID,
        membershipPlanId: FULL_ACCESS_PLAN_ID,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE', 'SCHEDULED'] },
      },
      _count: { _all: true },
    });

    const paymentsAt1700 = await prisma.payment.count({
      where: {
        studioId: STUDIO_ID,
        membershipPlanId: FULL_ACCESS_PLAN_ID,
        amountCents: EXPECTED_CATALOG_CENTS,
        status: 'SUCCEEDED',
      },
    });

    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'DRY_RUN_READ_ONLY',
      mutations: 'NONE',
      pii: 'REDACTED',
      cutoff: CUTOFF_ISO,
      catalogPriceCents: plan.priceCents,
      activeCount: active.length,
      legacyShouldStay1500: shouldStay1500.length,
      wrongLegacyLocks: wrongLock,
      missingLegacyLocks: missingLock,
      postCutoffCount: afterCutoff.length,
      lockDistribution: lockDist.map((row) => ({
        priceCents: row.priceCents,
        status: row.status,
        source: row.source,
        count: row._count._all,
      })),
      findings,
      repairNeededForLocks: wrongLock > 0 || missingLock > 0,
      paymentsAt1700,
      note:
        wrongLock === 0 && missingLock === 0
          ? 'Subscription locks are correct. Incident is display/API projection of catalog price onto existing members — fixed in application code, not via DB rewrite.'
          : 'Some locks diverge from 1500 or are missing — do NOT blanket UPDATE; craft per-row repair with human approval.',
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'audit failed');
  process.exit(1);
});
