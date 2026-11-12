/**
 * READ-ONLY / DRY-RUN audit for ARES Full Access grandfathering after catalog
 * rose from MXN 1,500 → MXN 1,700 (FUTURE_ONLY, 2026-11-11).
 *
 * Usage (production vars via Railway, no writes):
 *   railway run --service api npx ts-node -r tsconfig-paths/register \
 *     scripts/ares-full-access-price-lock-audit.ts
 *
 * Optional APPLY is intentionally unsupported: subscription locks are already
 * correct in production. This script never mutates DB or Stripe.
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
  email?: string;
};

async function main() {
  const prisma = new PrismaClient();
  const findings: Finding[] = [];

  try {
    const plan = await prisma.membershipPlan.findFirst({
      where: { id: FULL_ACCESS_PLAN_ID, studioId: STUDIO_ID },
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
      include: { items: true },
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
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const shouldStay1500 = active.filter((s) => s.createdAt < new Date(CUTOFF_ISO));
    const afterCutoff = active.filter((s) => s.createdAt >= new Date(CUTOFF_ISO));

    let wrongLock = 0;
    for (const s of shouldStay1500) {
      if (s.priceCents !== EXPECTED_LEGACY_CENTS) {
        wrongLock += 1;
        findings.push({
          severity: 'danger',
          code: 'LOCK_NOT_1500',
          subscriptionId: s.id,
          email: s.user.email,
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
          email: s.user.email,
          detail: `Post-cutoff lock is ${s.priceCents}, expected catalog ${EXPECTED_CATALOG_CENTS}`,
        });
      }
    }

    const paymentsAt1700 = await prisma.payment.count({
      where: {
        studioId: STUDIO_ID,
        membershipPlanId: FULL_ACCESS_PLAN_ID,
        amountCents: EXPECTED_CATALOG_CENTS,
        status: 'SUCCEEDED',
      },
    });

    findings.push({
      severity: paymentsAt1700 === 0 ? 'ok' : 'review',
      code: 'PAYMENTS_AT_1700',
      detail: `Succeeded Full Access payments at MXN 1700: ${paymentsAt1700}`,
    });

    const report = {
      generatedAt: new Date().toISOString(),
      mode: 'DRY_RUN_READ_ONLY',
      mutations: 'NONE',
      cutoff: CUTOFF_ISO,
      catalogPriceCents: plan.priceCents,
      activeCount: active.length,
      legacyShouldStay1500: shouldStay1500.length,
      wrongLegacyLocks: wrongLock,
      postCutoffCount: afterCutoff.length,
      secureMemberIds: shouldStay1500.map((s) => ({
        subscriptionId: s.id,
        userId: s.userId,
        email: s.user.email,
        source: s.source,
        status: s.status,
        priceCents: s.priceCents,
        createdAt: s.createdAt.toISOString(),
      })),
      findings,
      repairNeededForLocks: wrongLock > 0,
      note:
        wrongLock === 0
          ? 'Subscription locks are correct. Incident is display/API projection of catalog price onto existing members — fixed in application code, not via DB rewrite.'
          : 'Some locks diverge from 1500 — do NOT blanket UPDATE; craft per-row repair with human approval.',
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
