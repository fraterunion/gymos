/**
 * Read-only production snapshot for the Open Gym Full Access corrective release.
 *
 * Run it BEFORE the release and again AFTER, then diff the two outputs. Anything that differs
 * and is not a real member walking through the door is a mutation the release caused, which is
 * exactly what has to be proven absent.
 *
 * Performs no writes of any kind.
 *
 * Usage:
 *   railway run --service api npx ts-node --project tsconfig.seed.json \
 *     scripts/open-gym-release-verification.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const OPEN_GYM_MIGRATIONS = [
  '20260822200000_open_gym_facility_access',
  '20260822210000_open_gym_full_access_unrestricted',
];

function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(46)}${String(value)}`);
}

async function main(): Promise<void> {
  console.log('='.repeat(78));
  console.log(`OPEN GYM RELEASE SNAPSHOT  ${new Date().toISOString()}`);
  console.log('='.repeat(78));

  // ── Migration ledger ───────────────────────────────────────────────────────────────────
  console.log('\n[1] MIGRATION LEDGER');
  const migrations = await prisma.$queryRaw<
    Array<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
      applied_steps_count: number;
    }>
  >`
    SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
    FROM _prisma_migrations
    WHERE migration_name = ANY(${OPEN_GYM_MIGRATIONS})
    ORDER BY migration_name
  `;

  for (const name of OPEN_GYM_MIGRATIONS) {
    const row = migrations.find((m) => m.migration_name === name);
    if (!row) {
      line(`  ${name}`, 'NOT APPLIED');
      continue;
    }
    line(`  ${name}`, '');
    line('      checksum', row.checksum);
    line('      finished_at', row.finished_at?.toISOString() ?? 'null');
    line('      rolled_back_at', row.rolled_back_at?.toISOString() ?? 'null');
    line('      applied_steps_count', row.applied_steps_count);
  }

  const totalMigrations = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM _prisma_migrations WHERE rolled_back_at IS NULL
  `;
  line('  total applied migrations', totalMigrations[0]?.count);

  // ── ARES plan entitlements ─────────────────────────────────────────────────────────────
  console.log('\n[2] ARES PLAN ENTITLEMENTS');
  const studio = await prisma.studio.findFirst({
    where: { slug: 'ares-fitness', deletedAt: null },
    select: { id: true, name: true, timezone: true },
  });
  if (!studio) {
    console.log('  No ares-fitness studio found.');
    return;
  }
  line('  studio', `${studio.name} (${studio.id})`);
  line('  timezone', studio.timezone);

  const plans = await prisma.membershipPlan.findMany({
    where: { studioId: studio.id, deletedAt: null },
    select: {
      id: true,
      name: true,
      openGymAccess: true,
      openGymWindowStart: true,
      openGymWindowEnd: true,
    },
    orderBy: { name: 'asc' },
  });
  for (const p of plans) {
    const window =
      p.openGymWindowStart === null && p.openGymWindowEnd === null
        ? 'NULL..NULL (no restriction)'
        : `${p.openGymWindowStart}..${p.openGymWindowEnd}`;
    line(`  ${p.name}`, `openGymAccess=${p.openGymAccess}  window=${window}`);
  }

  // ── Other studios must be untouched ────────────────────────────────────────────────────
  console.log('\n[3] SAME-NAMED PLANS IN OTHER STUDIOS');
  const elsewhere = await prisma.membershipPlan.findMany({
    where: {
      deletedAt: null,
      studioId: { not: studio.id },
      name: { in: ['Full Access', 'Basic Access', 'Open Gym'] },
    },
    select: {
      name: true,
      openGymAccess: true,
      openGymWindowStart: true,
      openGymWindowEnd: true,
      studio: { select: { slug: true } },
    },
  });
  line('  count', elsewhere.length);
  for (const p of elsewhere) {
    line(
      `  ${p.studio.slug}/${p.name}`,
      `access=${p.openGymAccess} window=${p.openGymWindowStart ?? 'NULL'}..${p.openGymWindowEnd ?? 'NULL'}`,
    );
  }

  // ── Volumes that the release must not touch ────────────────────────────────────────────
  console.log('\n[4] MUTATION-SENSITIVE VOLUMES (studio-scoped)');
  const fullAccess = plans.find((p) => p.name === 'Full Access');
  const [subsTotal, subsActive, fullAccessCurrent, bookings, attendanceTotal, attendanceOpenGym, wallets] =
    await Promise.all([
      prisma.subscription.count({ where: { studioId: studio.id } }),
      prisma.subscription.count({
        where: { studioId: studio.id, status: { in: ['ACTIVE', 'TRIALING'] } },
      }),
      fullAccess
        ? prisma.subscription.count({
            where: {
              membershipPlanId: fullAccess.id,
              status: { in: ['ACTIVE', 'TRIALING'] },
              currentPeriodEnd: { gte: new Date() },
            },
          })
        : Promise.resolve(0),
      prisma.booking.count({ where: { studioId: studio.id } }),
      prisma.attendance.count({ where: { studioId: studio.id } }),
      prisma.attendance.count({ where: { studioId: studio.id, type: 'OPEN_GYM' } }),
      prisma.walletCredential.count({ where: { studioId: studio.id } }),
    ]);

  line('  subscriptions (all)', subsTotal);
  line('  subscriptions (active/trialing)', subsActive);
  line('  Full Access current subscribers', fullAccessCurrent);
  line('  bookings', bookings);
  line('  attendances (all)', attendanceTotal);
  line('  attendances (OPEN_GYM)', attendanceOpenGym);
  line('  wallet credentials', wallets);

  const latestWallet = await prisma.walletCredential.findFirst({
    where: { studioId: studio.id },
    orderBy: { updatedAt: 'desc' },
    select: { updatedAt: true },
  });
  line('  newest walletCredential.updatedAt', latestWallet?.updatedAt.toISOString() ?? 'n/a');

  const latestAttendance = await prisma.attendance.findFirst({
    where: { studioId: studio.id },
    orderBy: { checkedInAt: 'desc' },
    select: { checkedInAt: true, type: true },
  });
  line(
    '  newest attendance',
    latestAttendance
      ? `${latestAttendance.checkedInAt.toISOString()} (${latestAttendance.type})`
      : 'n/a',
  );

  const localNow = new Intl.DateTimeFormat('en-GB', {
    timeZone: studio.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: false,
  }).format(new Date());
  console.log(`\nStudio local time: ${localNow}`);
  console.log('='.repeat(78));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
