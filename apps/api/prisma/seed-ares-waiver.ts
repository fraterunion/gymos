/**
 * Idempotently seeds the active ARES Carta Responsiva v1.
 *
 * Usage:
 *   DATABASE_URL="..." pnpm --filter api seed:ares-waiver
 */
import { PrismaClient } from '@prisma/client';
import {
  ARES_WAIVER_BODY_MARKDOWN,
  ARES_WAIVER_TITLE,
  ARES_WAIVER_VERSION,
} from '../src/waiver/ares-waiver-v1.content';

const prisma = new PrismaClient();
const ARES_SLUG = 'ares-fitness';

async function main(): Promise<void> {
  const studio = await prisma.studio.findFirst({
    where: { slug: ARES_SLUG, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!studio) {
    console.error(`Studio not found: ${ARES_SLUG}`);
    process.exit(1);
  }

  const effectiveAt = new Date('2026-07-01T00:00:00.000Z');

  const existing = await prisma.studioWaiverDocument.findUnique({
    where: {
      studioId_version: { studioId: studio.id, version: ARES_WAIVER_VERSION },
    },
  });

  if (existing) {
    await prisma.studioWaiverDocument.updateMany({
      where: { studioId: studio.id, isActive: true, NOT: { id: existing.id } },
      data: { isActive: false },
    });
    await prisma.studioWaiverDocument.update({
      where: { id: existing.id },
      data: {
        title: ARES_WAIVER_TITLE,
        bodyMarkdown: ARES_WAIVER_BODY_MARKDOWN,
        effectiveAt,
        isActive: true,
      },
    });
    console.log(`Updated active waiver ${ARES_WAIVER_VERSION} for ${studio.name}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.studioWaiverDocument.updateMany({
      where: { studioId: studio.id, isActive: true },
      data: { isActive: false },
    });
    await tx.studioWaiverDocument.create({
      data: {
        studioId: studio.id,
        version: ARES_WAIVER_VERSION,
        title: ARES_WAIVER_TITLE,
        bodyMarkdown: ARES_WAIVER_BODY_MARKDOWN,
        effectiveAt,
        isActive: true,
      },
    });
  });

  console.log(`Created active waiver ${ARES_WAIVER_VERSION} for ${studio.name}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
