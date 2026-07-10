/**
 * Marks ARES App Review studio memberships for analytics exclusion.
 *
 * READ/WRITE on studio_memberships only — updates exclude_from_analytics for
 * exactly two emails on the ares-fitness studio. Safe to rerun.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." pnpm --filter api backfill:ares-review-analytics-exclusion
 *
 * Dry run:
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api backfill:ares-review-analytics-exclusion
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

const ARES_SLUG = 'ares-fitness';

const REVIEW_EMAILS = [
  'apple.review@fraterunion.com',
  'staff.review@fraterunion.com',
] as const;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  ARES REVIEW ANALYTICS EXCLUSION BACKFILL');
  console.log(`  Studio   : ${ARES_SLUG}`);
  console.log(`  Mode     : ${DRY_RUN ? 'DRY_RUN' : 'WRITE'}`);
  console.log('══════════════════════════════════════════════════════════════');

  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true },
  });

  if (!studio) {
    throw new Error(`Studio not found: ${ARES_SLUG}`);
  }

  console.log(`  Studio id: ${studio.id} (${studio.name})\n`);

  for (const email of REVIEW_EMAILS) {
    const membership = await prisma.studioMembership.findFirst({
      where: {
        studioId: studio.id,
        user: { email },
      },
      select: {
        id: true,
        role: true,
        excludeFromAnalytics: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
    });

    if (!membership) {
      console.log(`  [MISSING] ${email} — no studio membership on ARES`);
      continue;
    }

    const before = membership.excludeFromAnalytics;
    console.log(
      `  ${email} (${membership.user.firstName} ${membership.user.lastName}, ${membership.role})`,
    );
    console.log(`    before: excludeFromAnalytics = ${before}`);

    if (!DRY_RUN && !before) {
      await prisma.studioMembership.update({
        where: { id: membership.id },
        data: { excludeFromAnalytics: true },
      });
    }

    const after = DRY_RUN ? (before || true) : true;
    console.log(`    after : excludeFromAnalytics = ${after}`);
    console.log('');
  }

  console.log('Done. Only the two review emails above were targeted.');
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
