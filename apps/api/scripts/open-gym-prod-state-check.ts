/**
 * Read-only. Answers one question: what is the CURRENT production state of the Open Gym
 * migration, and who is affected by the Full Access window that should never have been written?
 *
 * Usage:
 *   railway run --service api npx ts-node --project tsconfig.seed.json \
 *     scripts/open-gym-prod-state-check.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const migrations = await prisma.$queryRaw<
    Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
  >`
    SELECT migration_name, finished_at, rolled_back_at
    FROM _prisma_migrations
    WHERE migration_name = '20260822200000_open_gym_facility_access'
  `;

  console.log('Migration record in production:');
  if (migrations.length === 0) {
    console.log('  NOT APPLIED');
  } else {
    for (const m of migrations) {
      console.log(`  ${m.migration_name}`);
      console.log(`    finished_at   = ${m.finished_at?.toISOString() ?? 'null'}`);
      console.log(`    rolled_back_at= ${m.rolled_back_at?.toISOString() ?? 'null'}`);
    }
  }

  const studio = await prisma.studio.findFirst({
    where: { slug: 'ares-fitness', deletedAt: null },
    select: { id: true, timezone: true },
  });
  if (!studio) {
    console.log('\nNo ares-fitness studio.');
    return;
  }

  const full = await prisma.membershipPlan.findFirst({
    where: { studioId: studio.id, name: 'Full Access', deletedAt: null },
    select: { id: true, openGymAccess: true, openGymWindowStart: true, openGymWindowEnd: true },
  });

  console.log('\nFull Access plan as it stands right now:');
  console.log(`  openGymAccess = ${full?.openGymAccess}`);
  console.log(`  window        = ${full?.openGymWindowStart ?? 'NULL'} .. ${full?.openGymWindowEnd ?? 'NULL'}`);

  const now = new Date();
  const localNow = new Intl.DateTimeFormat('en-GB', {
    timeZone: studio.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  console.log(`\nStudio local time now: ${localNow} (${studio.timezone})`);

  if (full) {
    const activeNow = await prisma.subscription.count({
      where: {
        membershipPlanId: full.id,
        status: { in: ['ACTIVE', 'TRIALING'] },
        currentPeriodEnd: { gte: now },
      },
    });
    console.log(`Members holding a current Full Access subscription: ${activeNow}`);
  }

  // Has anyone actually been admitted under the wrong window yet?
  const openGymVisits = await prisma.attendance.count({
    where: { studioId: studio.id, type: 'OPEN_GYM' },
  });
  console.log(`\nOPEN_GYM attendances recorded in production so far: ${openGymVisits}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
