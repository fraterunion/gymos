/**
 * READ-ONLY pre-flight for the Open Gym entitlement backfill.
 *
 * Prints exactly which membership_plans rows the migration
 * 20260822200000_open_gym_facility_access will change, and how many currently-entitled members
 * each change affects, so the data mutation can be reviewed before it is deployed rather than
 * after. Executes no writes and opens no transaction.
 *
 *   DATABASE_URL=<target> npx ts-node --project tsconfig.seed.json \
 *     scripts/open-gym-backfill-preflight.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ARES_SLUG = 'ares-fitness';

/** Must stay identical to the VALUES list in the migration's backfill statement. */
const TARGET_CONFIG: Record<string, { start: string; end: string }> = {
  'Basic Access': { start: '11:00', end: '22:00' },
  'Full Access': { start: '11:00', end: '22:00' },
  'Open Gym': { start: '11:00', end: '17:00' },
};

function fmt(value: string | null): string {
  return value ?? '—';
}

async function main() {
  const studio = await prisma.studio.findFirst({
    where: { slug: ARES_SLUG, deletedAt: null },
    select: { id: true, name: true, slug: true, timezone: true },
  });

  if (!studio) {
    console.log(`No studio with slug "${ARES_SLUG}" — the backfill would be a no-op here.`);
    return;
  }

  console.log(`Studio: ${studio.name} (${studio.slug})`);
  console.log(`Timezone used to evaluate Open Gym hours: ${studio.timezone}\n`);

  const plans = await prisma.membershipPlan.findMany({
    where: { studioId: studio.id, deletedAt: null },
    select: {
      id: true,
      name: true,
      active: true,
      openGymAccess: true,
      openGymWindowStart: true,
      openGymWindowEnd: true,
    },
    orderBy: { name: 'asc' },
  });

  const now = new Date();
  const rows: string[] = [];
  let changeCount = 0;

  for (const plan of plans) {
    const target = TARGET_CONFIG[plan.name];
    const entitledMembers = await prisma.subscription.count({
      where: {
        studioId: studio.id,
        membershipPlanId: plan.id,
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        currentPeriodEnd: { gte: now },
      },
    });

    if (!target) {
      rows.push(
        `  UNCHANGED  ${plan.name.padEnd(22)} openGym=${String(plan.openGymAccess).padEnd(5)} ` +
          `window=${fmt(plan.openGymWindowStart)}–${fmt(plan.openGymWindowEnd)}  members=${entitledMembers}`,
      );
      continue;
    }

    const alreadyCorrect =
      plan.openGymAccess &&
      plan.openGymWindowStart === target.start &&
      plan.openGymWindowEnd === target.end;

    if (alreadyCorrect) {
      rows.push(
        `  ALREADY OK ${plan.name.padEnd(22)} openGym=true  ` +
          `window=${target.start}–${target.end}  members=${entitledMembers}`,
      );
      continue;
    }

    changeCount++;
    rows.push(
      `  WILL CHANGE ${plan.name.padEnd(21)} ` +
        `openGym: ${plan.openGymAccess} -> true, ` +
        `window: ${fmt(plan.openGymWindowStart)}–${fmt(plan.openGymWindowEnd)} -> ${target.start}–${target.end}  ` +
        `members=${entitledMembers}  (plan id ${plan.id})`,
    );
  }

  console.log('membership_plans in this studio:');
  for (const row of rows) {
    console.log(row);
  }

  console.log(`\nRows the migration would UPDATE: ${changeCount}`);
  console.log('Every other plan, and every other studio, is left untouched.');

  const namedElsewhere = await prisma.membershipPlan.count({
    where: {
      deletedAt: null,
      name: { in: Object.keys(TARGET_CONFIG) },
      studioId: { not: studio.id },
    },
  });
  console.log(
    `Plans with these names in OTHER studios (all excluded by the studio-slug filter): ${namedElsewhere}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
