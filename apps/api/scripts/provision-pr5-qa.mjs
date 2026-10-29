import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Explicit, one-shot PR #5 acceptance fixture.
 * NEVER invoked by app bootstrap, migrations, pnpm postinstall or CI.
 * Emails end in .invalid and cannot be delivered to real members.
 */
export const QA_STUDIO_SLUG = 'ares-pr5-isolated-acceptance';
export const REHEARSAL_ENVIRONMENT_ID = '199dc576-0f26-4282-a83a-f832d0fde6fc';
const REHEARSAL_HOST = 'postgres-rehearsal.railway.internal';

export function assertSafeRehearsalQaTarget(env) {
  if (env.RAILWAY_ENVIRONMENT_ID !== REHEARSAL_ENVIRONMENT_ID ||
      env.ARES_PR5_QA_PROVISION !== 'I_AUTHORIZE_ISOLATED_QA_FIXTURE') {
    throw new Error('QA fixture blocked: requires explicit release-rehearsal environment and consent flag.');
  }
  let db;
  try { db = new URL(env.DATABASE_URL ?? ''); }
  catch { throw new Error('QA fixture blocked: invalid DATABASE_URL.'); }
  if (db.hostname.toLowerCase() !== REHEARSAL_HOST ||
      db.pathname !== '/railway' ||
      env.DATABASE_URL !== env.MIGRATION_DATABASE_URL) {
    throw new Error('QA fixture blocked: database must be the dedicated postgres-rehearsal, never ARES production.');
  }
  if (!(env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_') ||
      env.EMAIL_CAMPAIGN_WORKER !== '0') {
    throw new Error('QA fixture blocked: Stripe TEST required and campaign worker must remain off.');
  }
  const required = [
    env.ARES_QA_OWNER_PASSWORD,
    env.ARES_QA_FRONT_DESK_PASSWORD,
    env.ARES_QA_MEMBER_PASSWORD,
  ];
  if (required.some(value => typeof value !== 'string' || value.length < 20) ||
      new Set(required).size !== required.length) {
    throw new Error('QA fixture blocked: require three distinct 20+ character private environment passwords.');
  }
}

async function main() {
  // Guards run before constructing PrismaClient, hashing, or writing anything.
  assertSafeRehearsalQaTarget(process.env);

  const prismaModule = await import('@prisma/client');
  const { PrismaClient, Role, BillingInterval, SubscriptionSource, SubscriptionStatus } =
    prismaModule.default ?? prismaModule;
  const bcryptModule = await import('bcrypt');
  const bcrypt = bcryptModule.default ?? bcryptModule;
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.studio.findUnique({ where: { slug: QA_STUDIO_SLUG }, select: { id: true } });
    if (existing) throw new Error('QA fixture already exists. Refusing to reset or change any existing QA accounts.');

    const passwords = {
      OWNER: await bcrypt.hash(process.env.ARES_QA_OWNER_PASSWORD, 12),
      FRONT_DESK: await bcrypt.hash(process.env.ARES_QA_FRONT_DESK_PASSWORD, 12),
      MEMBER: await bcrypt.hash(process.env.ARES_QA_MEMBER_PASSWORD, 12),
    };
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const prices = [
      { label: 'Basic', priceCents: 100000 },
      { label: 'Pro', priceCents: 140000 },
      { label: 'Full', priceCents: 180000 },
    ];
    const result = await prisma.$transaction(async (tx) => {
      // All records are synthetic and isolated in their own rehearsal studio.
      const studio = await tx.studio.create({
        data: {
          slug: QA_STUDIO_SLUG,
          name: 'ARES PR5 QA — DATOS SINTÉTICOS',
          timezone: 'America/Mexico_City',
        },
      });
      async function addIdentity(localPart, role, hash) {
        const user = await tx.user.create({
          data: {
            email: `${localPart}@pr5-rehearsal.invalid`,
            firstName: 'QA',
            lastName: localPart,
            passwordHash: hash,
            studioMemberships: {
              create: { studioId: studio.id, role, excludeFromAnalytics: true },
            },
          },
        });
        return user;
      }
      await addIdentity('owner', Role.OWNER, passwords.OWNER);
      await addIdentity('reception', Role.FRONT_DESK, passwords.FRONT_DESK);
      const seeded = [];
      for (const price of prices) {
        const plan = await tx.membershipPlan.create({
          data: {
            studioId: studio.id,
            name: `QA ${price.label} — sintético`,
            description: 'Membresía ficticia de pruebas. No corresponde a los precios reales de ARES.',
            priceCents: price.priceCents,
            currency: 'mxn',
            billingInterval: BillingInterval.MONTHLY,
            active: true,
          },
        });
        for (let n = 1; n <= 2; n++) {
          const member = await addIdentity(
            `member-${price.label.toLowerCase()}-${n}`,
            Role.MEMBER,
            passwords.MEMBER,
          );
          await tx.subscription.create({
            data: {
              studioId: studio.id,
              userId: member.id,
              membershipPlanId: plan.id,
              source: SubscriptionSource.CASH,
              status: SubscriptionStatus.ACTIVE,
              priceCents: price.priceCents,
              currentPeriodStart: now,
              currentPeriodEnd: periodEnd,
              notes: 'PR5 isolated QA fixture: NO real payment',
            },
          });
        }
        seeded.push({ plan: price.label, planId: plan.id, syntheticMemberCount: 2 });
      }
      return { studioId: studio.id, slug: studio.slug, plans: seeded };
    }, { timeout: 30_000 });

    // Output excludes passwords, hashes, Stripe IDs and token material.
    console.log(JSON.stringify({
      status: 'ISOLATED_QA_FIXTURE_CREATED',
      ...result,
      ownerEmail: 'owner@pr5-rehearsal.invalid',
      receptionEmail: 'reception@pr5-rehearsal.invalid',
      note: 'Synthetic QA only. Secrets remain in private environment variables.',
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('QA fixture not provisioned:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  });
}
