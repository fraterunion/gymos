/**
 * Ares Training Club — Apple App Review demo accounts (production-safe upsert).
 *
 * Creates or updates ONLY these two emails:
 *   apple.review@fraterunion.com   — MEMBER + active internal subscription
 *   staff.review@fraterunion.com   — STAFF + FRONT_DESK profile
 *
 * Never deletes data. Never creates Payment rows. Never calls Stripe.
 * Safe to re-run (idempotent upserts).
 *
 * DRY RUN:
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api seed:ares-review
 *
 * Production:
 *   DATABASE_URL="postgresql://..." pnpm --filter api seed:ares-review
 */

import * as bcrypt from 'bcrypt';
import {
  PrismaClient,
  Role,
  StaffType,
  SubscriptionStatus,
} from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

const ARES_SLUG = 'ares-fitness';
const REVIEW_PASSWORD = 'Review2026!';

const MEMBER_EMAIL = 'apple.review@fraterunion.com';
const STAFF_EMAIL = 'staff.review@fraterunion.com';

/** Clearly internal — not a real Stripe subscription ID. */
const REVIEW_STRIPE_SUB_ID = 'sub_review_apple_member_ares';

const FULL_ACCESS_PLAN_NAME = 'Full Access';

function log(op: string, entity: string, detail: string): void {
  const prefix = DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]';
  console.log(`${prefix} ${op.padEnd(7)} ${entity.padEnd(22)} ${detail}`);
}

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 12);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

async function upsertReviewUser(params: {
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
}): Promise<string> {
  log('UPSERT', 'User', params.email);
  if (DRY_RUN) {
    const existing = await prisma.user.findUnique({
      where: { email: params.email },
      select: { id: true },
    });
    return existing?.id ?? `dry-run-${params.email}`;
  }

  const user = await prisma.user.upsert({
    where: { email: params.email },
    create: {
      email: params.email,
      firstName: params.firstName,
      lastName: params.lastName,
      passwordHash: params.passwordHash,
    },
    update: {
      firstName: params.firstName,
      lastName: params.lastName,
      passwordHash: params.passwordHash,
      deletedAt: null,
    },
    select: { id: true },
  });
  return user.id;
}

async function upsertStudioMembership(params: {
  studioId: string;
  userId: string;
  role: Role;
}): Promise<void> {
  log('UPSERT', 'StudioMembership', `${params.userId.slice(0, 8)}… → ${params.role}`);
  if (DRY_RUN) return;

  await prisma.studioMembership.upsert({
    where: { userId_studioId: { userId: params.userId, studioId: params.studioId } },
    create: {
      studioId: params.studioId,
      userId: params.userId,
      role: params.role,
    },
    update: {
      role: params.role,
      deletedAt: null,
    },
  });
}

async function upsertMemberSubscription(params: {
  studioId: string;
  userId: string;
  membershipPlanId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<void> {
  const existing = await prisma.subscription.findFirst({
    where: {
      studioId: params.studioId,
      userId: params.userId,
      status: SubscriptionStatus.ACTIVE,
    },
    select: { id: true },
  });

  if (existing) {
    log('UPDATE', 'Subscription', `ACTIVE → plan ${FULL_ACCESS_PLAN_NAME}`);
    if (!DRY_RUN) {
      await prisma.subscription.update({
        where: { id: existing.id },
        data: {
          membershipPlanId: params.membershipPlanId,
          status: SubscriptionStatus.ACTIVE,
          stripeSubscriptionId: REVIEW_STRIPE_SUB_ID,
          currentPeriodStart: params.periodStart,
          currentPeriodEnd: params.periodEnd,
          cancelAtPeriodEnd: false,
        },
      });
    }
    return;
  }

  log('CREATE', 'Subscription', `ACTIVE ${FULL_ACCESS_PLAN_NAME} (no Stripe charge)`);
  if (!DRY_RUN) {
    await prisma.subscription.create({
      data: {
        studioId: params.studioId,
        userId: params.userId,
        membershipPlanId: params.membershipPlanId,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: REVIEW_STRIPE_SUB_ID,
        currentPeriodStart: params.periodStart,
        currentPeriodEnd: params.periodEnd,
        cancelAtPeriodEnd: false,
      },
    });
  }
}

async function upsertStaffProfile(params: {
  studioId: string;
  userId: string;
}): Promise<void> {
  log('UPSERT', 'StudioStaffProfile', 'FRONT_DESK isActive=true');
  if (DRY_RUN) return;

  await prisma.studioStaffProfile.upsert({
    where: { studioId_userId: { studioId: params.studioId, userId: params.userId } },
    create: {
      studioId: params.studioId,
      userId: params.userId,
      staffType: StaffType.FRONT_DESK,
      isActive: true,
    },
    update: {
      staffType: StaffType.FRONT_DESK,
      isActive: true,
    },
  });
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log('════════════════════════════════════════════════');
    console.log('  DRY RUN — zero writes will occur');
    console.log('════════════════════════════════════════════════\n');
  }

  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, slug: true, name: true },
  });
  if (!studio) {
    throw new Error(`Studio not found: ${ARES_SLUG}. Run seed:ares first or verify production DB.`);
  }
  console.log(`Studio: ${studio.name} (${studio.slug})\n`);

  const fullAccessPlan = await prisma.membershipPlan.findFirst({
    where: {
      studioId: studio.id,
      name: FULL_ACCESS_PLAN_NAME,
      deletedAt: null,
      active: true,
    },
    select: { id: true, name: true, classCredits: true },
  });
  if (!fullAccessPlan) {
    throw new Error(
      `"${FULL_ACCESS_PLAN_NAME}" plan not found for ${ARES_SLUG}. ` +
        'Run seed:ares to upsert membership plans before review accounts.',
    );
  }
  console.log(
    `Plan: ${fullAccessPlan.name} (classCredits=${fullAccessPlan.classCredits ?? 'unlimited'})\n`,
  );

  const passwordHash = hashPassword(REVIEW_PASSWORD);
  const now = new Date();
  const periodStart = addDays(now, -7);
  const periodEnd = addDays(now, 365);

  console.log('── Member review account ──');
  const memberUserId = await upsertReviewUser({
    email: MEMBER_EMAIL,
    firstName: 'Apple',
    lastName: 'Review',
    passwordHash,
  });
  await upsertStudioMembership({
    studioId: studio.id,
    userId: memberUserId,
    role: Role.MEMBER,
  });
  await upsertMemberSubscription({
    studioId: studio.id,
    userId: memberUserId,
    membershipPlanId: fullAccessPlan.id,
    periodStart,
    periodEnd,
  });

  console.log('\n── Staff review account ──');
  const staffUserId = await upsertReviewUser({
    email: STAFF_EMAIL,
    firstName: 'Apple',
    lastName: 'Staff Review',
    passwordHash,
  });
  await upsertStudioMembership({
    studioId: studio.id,
    userId: staffUserId,
    role: Role.FRONT_DESK,
  });
  await upsertStaffProfile({
    studioId: studio.id,
    userId: staffUserId,
  });

  console.log('');
  console.log(
    JSON.stringify(
      {
        event: 'seed_ares_review_accounts_complete',
        studio: ARES_SLUG,
        dry_run: DRY_RUN,
        accounts: [
          {
            email: MEMBER_EMAIL,
            password: REVIEW_PASSWORD,
            role: 'MEMBER',
            subscription: {
              plan: FULL_ACCESS_PLAN_NAME,
              status: 'ACTIVE',
              stripeSubscriptionId: REVIEW_STRIPE_SUB_ID,
              note: 'Internal DB row only — no Stripe charge',
            },
          },
          {
            email: STAFF_EMAIL,
            password: REVIEW_PASSWORD,
            role: 'STAFF',
            staffType: 'FRONT_DESK',
          },
        ],
        never_touched: ['Payment', 'Booking', 'Attendance', 'QRToken', 'real Stripe API'],
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
