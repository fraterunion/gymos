/**
 * Ares Training Club — member visibility audit (Admin Web vs Mobile).
 *
 * READ-ONLY. Zero writes. Safe against production.
 *
 * Compares:
 *   - Admin Web "Miembros" (all studio memberships from GET /members)
 *   - Mobile directory (role === 'MEMBER' client filter)
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." pnpm --filter api exec ts-node --project tsconfig.seed.json prisma/audit-ares-member-visibility.ts
 */

import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();
const ARES_SLUG = 'ares-fitness';

const NON_MEMBER_ROLES: Role[] = [
  Role.INSTRUCTOR,
  Role.STAFF,
  Role.FRONT_DESK,
  Role.ADMIN,
  Role.OWNER,
];

async function main(): Promise<void> {
  const now = new Date();

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  ARES MEMBER VISIBILITY AUDIT  (READ-ONLY)');
  console.log(`  Studio : ${ARES_SLUG}`);
  console.log(`  Run at : ${now.toISOString()}`);
  console.log('════════════════════════════════════════════════════════════════');

  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true },
  });

  if (!studio) {
    console.error(`Studio not found: ${ARES_SLUG}`);
    process.exit(1);
  }

  console.log(`  DB id  : ${studio.id}  (${studio.name})`);

  const memberships = await prisma.studioMembership.findMany({
    where: {
      studioId: studio.id,
      deletedAt: null,
      user: { deletedAt: null },
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          platformRole: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });

  const adminWebTotal = memberships.length;
  const mobileVisible = memberships.filter((m) => m.role === Role.MEMBER);
  const suspicious = memberships.filter((m) => m.role !== Role.MEMBER);

  const subs = await prisma.subscription.findMany({
    where: { studioId: studio.id, userId: { in: memberships.map((m) => m.userId) } },
    select: {
      userId: true,
      status: true,
      membershipPlan: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const subByUser = new Map<string, { status: string; planName: string }>();
  for (const s of subs) {
    if (!subByUser.has(s.userId)) {
      subByUser.set(s.userId, { status: s.status, planName: s.membershipPlan.name });
    }
  }

  console.log('\n── COUNTS ──────────────────────────────────────────────────────');
  console.log(`  Admin Web list (all memberships)     : ${adminWebTotal}`);
  console.log(`  Mobile-visible (role = MEMBER)       : ${mobileVisible.length}`);
  console.log(`  Suspicious (non-MEMBER in Admin)     : ${suspicious.length}`);

  console.log('\n── ROLE BREAKDOWN (Admin Web) ──────────────────────────────────');
  const byRole = new Map<string, number>();
  for (const m of memberships) {
    byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  }
  for (const [role, count] of [...byRole.entries()].sort()) {
    console.log(`  ${role.padEnd(12)} ${count}`);
  }

  console.log('\n── SUSPICIOUS RECORDS (Admin yes / Mobile no) ──────────────────');
  if (suspicious.length === 0) {
    console.log('  (none)');
  } else {
    for (const m of suspicious) {
      const sub = subByUser.get(m.userId);
      console.log('');
      console.log(`  Name           : ${m.user.firstName} ${m.user.lastName}`);
      console.log(`  Email          : ${m.user.email}`);
      console.log(`  userId         : ${m.user.id}`);
      console.log(`  membershipId   : ${m.id}`);
      console.log(`  studio role    : ${m.role}`);
      console.log(`  platform role  : ${m.user.platformRole ?? '(none)'}`);
      console.log(`  joined         : ${m.createdAt.toISOString()}`);
      console.log(
        `  subscription   : ${sub ? `${sub.planName} (${sub.status})` : '(none)'}`,
      );
      console.log(
        `  why in Admin   : GET /members returns all StudioMembership rows; no role filter`,
      );
      console.log(
        `  why not Mobile : client filter m.role === 'MEMBER' in members-directory`,
      );
    }
  }

  console.log('\n── MOBILE MEMBERS (role = MEMBER) ──────────────────────────────');
  for (const m of mobileVisible) {
    const sub = subByUser.get(m.userId);
    console.log(
      `  ${m.user.firstName} ${m.user.lastName} <${m.user.email}>  sub=${sub?.status ?? 'none'}`,
    );
  }

  console.log('\n── JSON SUMMARY ────────────────────────────────────────────────');
  console.log(
    JSON.stringify(
      {
        event: 'audit_ares_member_visibility',
        studio: ARES_SLUG,
        runAt: now.toISOString(),
        counts: {
          adminWebTotal,
          mobileVisible: mobileVisible.length,
          suspicious: suspicious.length,
        },
        roleBreakdown: Object.fromEntries(byRole),
        suspiciousRecords: suspicious.map((m) => ({
          userId: m.user.id,
          membershipId: m.id,
          name: `${m.user.firstName} ${m.user.lastName}`,
          email: m.user.email,
          studioRole: m.role,
          platformRole: m.user.platformRole,
          joinedAt: m.createdAt.toISOString(),
          subscription: subByUser.get(m.userId) ?? null,
          reason:
            'StudioMembership.role is not MEMBER; Admin Web shows all memberships; Mobile filters MEMBER only',
        })),
        mobileMembers: mobileVisible.map((m) => ({
          userId: m.user.id,
          email: m.user.email,
          name: `${m.user.firstName} ${m.user.lastName}`,
          studioRole: m.role,
        })),
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
