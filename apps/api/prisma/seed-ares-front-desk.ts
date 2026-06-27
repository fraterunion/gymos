/**
 * Ares Training Club — production front-desk reception account (safe upsert).
 *
 * Creates or updates:
 *   recepcion@arestrainingclub.com — FRONT_DESK role + FRONT_DESK staff profile
 *
 * Never deletes data. Never calls Stripe. Idempotent.
 *
 * DRY RUN:
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api seed:ares-front-desk
 *
 * Production:
 *   DATABASE_URL="postgresql://..." pnpm --filter api seed:ares-front-desk
 */

import * as bcrypt from 'bcrypt';
import { PrismaClient, Role, StaffType } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

const ARES_SLUG = 'ares-fitness';
const FRONT_DESK_EMAIL = 'recepcion@arestrainingclub.com';
const FRONT_DESK_PASSWORD = 'AresFrontDesk2026!';

function log(op: string, entity: string, detail: string): void {
  const prefix = DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]';
  console.log(`${prefix} ${op.padEnd(7)} ${entity.padEnd(22)} ${detail}`);
}

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12);
}

async function main(): Promise<void> {
  const studio = await prisma.studio.findUniqueOrThrow({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true, slug: true },
  });
  console.log(`Studio: ${studio.name} (${studio.slug})\n`);

  log('UPSERT', 'User', FRONT_DESK_EMAIL);
  let userId: string;
  if (DRY_RUN) {
    const existing = await prisma.user.findUnique({
      where: { email: FRONT_DESK_EMAIL },
      select: { id: true },
    });
    userId = existing?.id ?? `dry-run-${FRONT_DESK_EMAIL}`;
  } else {
    const user = await prisma.user.upsert({
      where: { email: FRONT_DESK_EMAIL },
      create: {
        email: FRONT_DESK_EMAIL,
        firstName: 'Recepción',
        lastName: 'ARES',
        passwordHash: hashPassword(FRONT_DESK_PASSWORD),
        platformRole: null,
      },
      update: {
        firstName: 'Recepción',
        lastName: 'ARES',
        passwordHash: hashPassword(FRONT_DESK_PASSWORD),
        platformRole: null,
        deletedAt: null,
      },
      select: { id: true },
    });
    userId = user.id;
  }

  log('UPSERT', 'StudioMembership', `${FRONT_DESK_EMAIL} → FRONT_DESK`);
  if (!DRY_RUN) {
    await prisma.studioMembership.upsert({
      where: { userId_studioId: { userId, studioId: studio.id } },
      create: {
        studioId: studio.id,
        userId,
        role: Role.FRONT_DESK,
      },
      update: {
        role: Role.FRONT_DESK,
        deletedAt: null,
      },
    });
  }

  log('UPSERT', 'StudioStaffProfile', `${FRONT_DESK_EMAIL} → FRONT_DESK`);
  if (!DRY_RUN) {
    await prisma.studioStaffProfile.upsert({
      where: { studioId_userId: { studioId: studio.id, userId } },
      create: {
        studioId: studio.id,
        userId,
        staffType: StaffType.FRONT_DESK,
        isActive: true,
      },
      update: {
        staffType: StaffType.FRONT_DESK,
        isActive: true,
      },
    });
  }

  console.log('\nFront desk account ready.');
  console.log(`  Email:    ${FRONT_DESK_EMAIL}`);
  console.log(`  Password: ${FRONT_DESK_PASSWORD}`);
  console.log(`  Role:     FRONT_DESK`);
  console.log(`  Studio:   ${studio.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
