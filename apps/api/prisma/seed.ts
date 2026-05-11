import {
  BillingInterval,
  ClassStatus,
  PrismaClient,
  Role,
  SubscriptionStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const DEV_PASSWORD_HASH = bcrypt.hashSync('password12', 12);

async function main() {
  const studio = await prisma.studio.create({
    data: {
      name: 'GymOS Dev Studio',
      slug: 'gymos-dev',
      timezone: 'America/New_York',
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@gymos.local',
      firstName: 'Alex',
      lastName: 'Admin',
      phone: '+15555550100',
      passwordHash: DEV_PASSWORD_HASH,
      stripeCustomerId: 'cus_seed_admin',
    },
  });

  const memberUser = await prisma.user.create({
    data: {
      email: 'member@gymos.local',
      firstName: 'Morgan',
      lastName: 'Member',
      passwordHash: DEV_PASSWORD_HASH,
      stripeCustomerId: 'cus_seed_member',
    },
  });

  await prisma.studioMembership.create({
    data: {
      studioId: studio.id,
      userId: adminUser.id,
      role: Role.ADMIN,
    },
  });

  await prisma.studioMembership.create({
    data: {
      studioId: studio.id,
      userId: memberUser.id,
      role: Role.MEMBER,
    },
  });

  const plan = await prisma.membershipPlan.create({
    data: {
      studioId: studio.id,
      name: 'Unlimited Monthly',
      description: 'Dev seed plan',
      priceCents: 19900,
      currency: 'usd',
      billingInterval: BillingInterval.MONTHLY,
    },
  });

  await prisma.subscription.create({
    data: {
      studioId: studio.id,
      userId: memberUser.id,
      membershipPlanId: plan.id,
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: 'sub_seed_member',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  const templateVinyasa = await prisma.classTemplate.create({
    data: {
      studioId: studio.id,
      name: 'Vinyasa Flow',
      durationMinutes: 60,
      description: 'Dev seed template',
    },
  });

  const templateHiit = await prisma.classTemplate.create({
    data: {
      studioId: studio.id,
      name: 'HIIT',
      durationMinutes: 45,
      description: 'Dev seed template',
    },
  });

  const start1 = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end1 = new Date(start1.getTime() + 60 * 60 * 1000);
  const start2 = new Date(start1.getTime() + 2 * 60 * 60 * 1000);
  const end2 = new Date(start2.getTime() + 45 * 60 * 1000);

  await prisma.scheduledClass.create({
    data: {
      studioId: studio.id,
      classTemplateId: templateVinyasa.id,
      instructorId: adminUser.id,
      startsAt: start1,
      endsAt: end1,
      capacity: 12,
      status: ClassStatus.SCHEDULED,
    },
  });

  await prisma.scheduledClass.create({
    data: {
      studioId: studio.id,
      classTemplateId: templateHiit.id,
      instructorId: null,
      startsAt: start2,
      endsAt: end2,
      capacity: 16,
      status: ClassStatus.SCHEDULED,
    },
  });
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
