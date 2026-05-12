/**
 * GymOS pilot/demo seed — ARES Fitness & Pilates Toluca.
 * Idempotent for re-runs: clears prior demo studios/users (see DEMO_SLUGS / demo email domains).
 *
 * Shared demo password: see docs/DEMO_ENVIRONMENT.md (not a production secret).
 */
import {
  BillingInterval,
  BookingStatus,
  CancelSource,
  CheckInMethod,
  ClassStatus,
  PaymentStatus,
  PrismaClient,
  Role,
  SubscriptionStatus,
  WaitlistStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/** Documented in docs/DEMO_ENVIRONMENT.md — local / private demo only. */
const DEMO_PASSWORD = 'DemoGymOS2026!';

const DEMO_SLUGS = ['ares-fitness', 'pilates-toluca', 'gymos-dev'] as const;

function hashDemoPassword(): string {
  return bcrypt.hashSync(DEMO_PASSWORD, 12);
}

/** Wall-clock relative dates (seed host timezone). Good enough for schedules & QA. */
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}

function atLocalTime(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function clearDemoData(): Promise<void> {
  const studios = await prisma.studio.findMany({
    where: { slug: { in: [...DEMO_SLUGS] } },
    select: { id: true },
  });
  const studioIds = studios.map((s) => s.id);

  const demoUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { endsWith: '@ares.demo' } },
        { email: { endsWith: '@pilates.demo' } },
        { email: { endsWith: '@gymos.local' } },
      ],
    },
    select: { id: true },
  });
  const userIds = demoUsers.map((u) => u.id);

  if (studioIds.length === 0 && userIds.length === 0) {
    return;
  }

  if (studioIds.length > 0) {
    await prisma.qRToken.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.attendance.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.waitlistEntry.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.booking.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.scheduledClass.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.classTemplate.updateMany({
      where: { studioId: { in: studioIds } },
      data: { defaultInstructorId: null },
    });
    await prisma.classTemplate.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.subscription.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.payment.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.studioMembership.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.membershipPlan.deleteMany({ where: { studioId: { in: studioIds } } });
    await prisma.studio.deleteMany({ where: { id: { in: studioIds } } });
  }

  if (userIds.length > 0) {
    await prisma.qRToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.studioMembership.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function main(): Promise<void> {
  await clearDemoData();
  const passwordHash = hashDemoPassword();
  const now = new Date();

  // --- ARES Fitness ---
  const ares = await prisma.studio.create({
    data: {
      name: 'ARES Fitness',
      slug: 'ares-fitness',
      timezone: 'America/New_York',
      appName: 'ARES Fitness',
      brandPrimaryColor: '#0f172a',
      brandSecondaryColor: '#c9a227',
      brandLogoUrl: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=400',
      supportEmail: 'hello@ares.demo',
      supportPhone: '+1 (555) 010-2001',
      privacyUrl: 'https://example.com/ares/privacy',
      termsUrl: 'https://example.com/ares/terms',
      iosBundleId: 'com.aresfitness.member',
      androidPackageName: 'com.aresfitness.member',
    },
  });

  const aresAdmin = await prisma.user.create({
    data: {
      email: 'admin@ares.demo',
      firstName: 'Jordan',
      lastName: 'Reyes',
      phone: '+1 (555) 010-2010',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_admin',
    },
  });
  const aresStaff = await prisma.user.create({
    data: {
      email: 'staff@ares.demo',
      firstName: 'Sam',
      lastName: 'Okonkwo',
      phone: '+1 (555) 010-2011',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_staff',
    },
  });
  const aresInstructor = await prisma.user.create({
    data: {
      email: 'instructor@ares.demo',
      firstName: 'Riley',
      lastName: 'Chen',
      phone: '+1 (555) 010-2012',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_instructor',
    },
  });
  const aresM1 = await prisma.user.create({
    data: {
      email: 'member1@ares.demo',
      firstName: 'Casey',
      lastName: 'Brooks',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m1',
    },
  });
  const aresM2 = await prisma.user.create({
    data: {
      email: 'member2@ares.demo',
      firstName: 'Taylor',
      lastName: 'Nguyen',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m2',
    },
  });
  const aresM3 = await prisma.user.create({
    data: {
      email: 'member3@ares.demo',
      firstName: 'Jamie',
      lastName: 'Patel',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m3',
    },
  });
  const aresM4 = await prisma.user.create({
    data: {
      email: 'member4@ares.demo',
      firstName: 'Alex',
      lastName: 'Martinez',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m4',
    },
  });
  const aresM5 = await prisma.user.create({
    data: {
      email: 'member5@ares.demo',
      firstName: 'Quinn',
      lastName: 'Lopez',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m5',
    },
  });
  const aresM6 = await prisma.user.create({
    data: {
      email: 'member6@ares.demo',
      firstName: 'Rae',
      lastName: 'Kim',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_m6',
    },
  });

  const rolesAres: { userId: string; role: Role }[] = [
    { userId: aresAdmin.id, role: Role.ADMIN },
    { userId: aresStaff.id, role: Role.STAFF },
    { userId: aresInstructor.id, role: Role.INSTRUCTOR },
    { userId: aresM1.id, role: Role.MEMBER },
    { userId: aresM2.id, role: Role.MEMBER },
    { userId: aresM3.id, role: Role.MEMBER },
    { userId: aresM4.id, role: Role.MEMBER },
    { userId: aresM5.id, role: Role.MEMBER },
    { userId: aresM6.id, role: Role.MEMBER },
  ];
  await prisma.studioMembership.createMany({
    data: rolesAres.map((r) => ({ studioId: ares.id, userId: r.userId, role: r.role })),
  });

  const aresUnlimited = await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Unlimited Strength',
      description:
        'Unlimited group classes, open gym access, and one guest pass per month. Perfect for athletes who live on the floor.',
      priceCents: 18900,
      currency: 'usd',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: null,
      active: true,
      stripeProductId: 'prod_demo_ares_unlimited',
      stripePriceId: 'price_demo_ares_unlimited_monthly',
    },
  });
  const aresFlex8 = await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Flex 8',
      description: 'Eight class credits per month — roll unused credits for 30 days when you renew.',
      priceCents: 12900,
      currency: 'usd',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: 8,
      active: true,
      stripeProductId: 'prod_demo_ares_flex8',
      stripePriceId: 'price_demo_ares_flex8_monthly',
    },
  });

  const periodStart = addDays(now, -5);
  const periodEnd = addDays(now, 25);
  await prisma.subscription.createMany({
    data: [
      {
        studioId: ares.id,
        userId: aresM1.id,
        membershipPlanId: aresUnlimited.id,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: 'sub_demo_ares_m1_unlimited',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
      {
        studioId: ares.id,
        userId: aresM2.id,
        membershipPlanId: aresFlex8.id,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: 'sub_demo_ares_m2_flex8',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
      {
        studioId: ares.id,
        userId: aresM3.id,
        membershipPlanId: aresFlex8.id,
        status: SubscriptionStatus.PAST_DUE,
        stripeSubscriptionId: 'sub_demo_ares_m3_pastdue',
        currentPeriodStart: addDays(now, -40),
        currentPeriodEnd: addDays(now, -3),
        cancelAtPeriodEnd: true,
      },
    ],
  });

  await prisma.payment.create({
    data: {
      studioId: ares.id,
      userId: aresM1.id,
      amountCents: 18900,
      currency: 'usd',
      status: PaymentStatus.SUCCEEDED,
      stripePaymentIntentId: 'pi_demo_ares_m1_invoice_001',
      stripeInvoiceId: 'in_demo_ares_m1_001',
    },
  });

  const tplPower = await prisma.classTemplate.create({
    data: {
      studioId: ares.id,
      name: 'Power Hour',
      durationMinutes: 60,
      description:
        'Heavy compound lifts in rotating stations — squat, hinge, push, pull. Coaches scale load for every level.',
      defaultCapacity: 14,
      color: '#c9a227',
      defaultInstructorId: aresInstructor.id,
    },
  });
  const tplMetcon = await prisma.classTemplate.create({
    data: {
      studioId: ares.id,
      name: 'MetCon Small Group',
      durationMinutes: 45,
      description: 'High-intensity intervals with kettlebells, rowers, and sleds. Heart rate optional; effort mandatory.',
      defaultCapacity: 10,
      color: '#ef4444',
      defaultInstructorId: aresInstructor.id,
    },
  });
  const tplYogaMobility = await prisma.classTemplate.create({
    data: {
      studioId: ares.id,
      name: 'Mobility & Breath',
      durationMinutes: 50,
      description: 'Slow flow focused on thoracic spine, hips, and breath work — ideal after heavy training days.',
      defaultCapacity: 20,
      color: '#38bdf8',
      defaultInstructorId: aresInstructor.id,
    },
  });

  const aresClasses: {
    templateId: string;
    day: number;
    hour: number;
    cap: number;
    durationMin: number;
    status: ClassStatus;
  }[] = [];
  for (let d = 0; d <= 7; d++) {
    aresClasses.push(
      {
        templateId: tplPower.id,
        day: d,
        hour: 6,
        cap: 14,
        durationMin: 60,
        status: ClassStatus.SCHEDULED,
      },
      {
        templateId: tplMetcon.id,
        day: d,
        hour: 12,
        cap: 10,
        durationMin: 45,
        status: ClassStatus.SCHEDULED,
      },
      {
        templateId: tplYogaMobility.id,
        day: d,
        hour: 18,
        cap: 20,
        durationMin: 50,
        status: ClassStatus.SCHEDULED,
      },
    );
  }

  const scheduledAres: { id: string; startsAt: Date; templateId: string }[] = [];
  for (const row of aresClasses) {
    const base = addDays(now, row.day);
    const startsAt = atLocalTime(base, row.hour, 0);
    const endsAt = new Date(startsAt.getTime() + row.durationMin * 60 * 1000);
    const sc = await prisma.scheduledClass.create({
      data: {
        studioId: ares.id,
        classTemplateId: row.templateId,
        instructorId: aresInstructor.id,
        startsAt,
        endsAt,
        capacity: row.cap,
        status: row.status,
      },
    });
    scheduledAres.push({ id: sc.id, startsAt, templateId: row.templateId });
  }

  const futureMetcon = scheduledAres.find(
    (c) => c.startsAt > now && c.templateId === tplMetcon.id,
  );
  const metconId = futureMetcon?.id ?? scheduledAres.find((c) => c.templateId === tplMetcon.id)!.id;

  await prisma.scheduledClass.update({
    where: { id: metconId },
    data: { capacity: 3 },
  });

  await prisma.booking.createMany({
    data: [
      {
        studioId: ares.id,
        scheduledClassId: metconId,
        userId: aresM1.id,
        status: BookingStatus.CONFIRMED,
      },
      {
        studioId: ares.id,
        scheduledClassId: metconId,
        userId: aresM2.id,
        status: BookingStatus.CONFIRMED,
      },
      {
        studioId: ares.id,
        scheduledClassId: metconId,
        userId: aresM3.id,
        status: BookingStatus.CONFIRMED,
      },
    ],
  });

  await prisma.waitlistEntry.createMany({
    data: [
      {
        studioId: ares.id,
        scheduledClassId: metconId,
        userId: aresM4.id,
        status: WaitlistStatus.WAITING,
        position: 1,
      },
      {
        studioId: ares.id,
        scheduledClassId: metconId,
        userId: aresM5.id,
        status: WaitlistStatus.WAITING,
        position: 2,
      },
    ],
  });

  const powerSoon =
    scheduledAres.find((c) => c.templateId === tplPower.id && c.startsAt > now) ??
    scheduledAres.find((c) => c.templateId === tplPower.id);
  const powerId = powerSoon!.id;

  await prisma.scheduledClass.update({
    where: { id: powerId },
    data: { capacity: 4 },
  });

  await prisma.booking.createMany({
    data: [
      {
        studioId: ares.id,
        scheduledClassId: powerId,
        userId: aresM1.id,
        status: BookingStatus.CONFIRMED,
      },
      {
        studioId: ares.id,
        scheduledClassId: powerId,
        userId: aresM2.id,
        status: BookingStatus.CANCELLED,
        cancelSource: CancelSource.MEMBER,
        cancelledAt: addDays(now, -1),
      },
      {
        studioId: ares.id,
        scheduledClassId: powerId,
        userId: aresM4.id,
        status: BookingStatus.CONFIRMED,
      },
      {
        studioId: ares.id,
        scheduledClassId: powerId,
        userId: aresM5.id,
        status: BookingStatus.CONFIRMED,
      },
    ],
  });

  await prisma.waitlistEntry.create({
    data: {
      studioId: ares.id,
      scheduledClassId: powerId,
      userId: aresM6.id,
      status: WaitlistStatus.PROMOTED,
      position: 1,
    },
  });

  await prisma.booking.create({
    data: {
      studioId: ares.id,
      scheduledClassId: powerId,
      userId: aresM6.id,
      status: BookingStatus.CONFIRMED,
    },
  });

  const pastPower =
    scheduledAres
      .filter((c) => c.startsAt < now && c.templateId === tplPower.id)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0] ??
    scheduledAres
      .filter((c) => c.startsAt < now)
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
  if (pastPower) {
    await prisma.scheduledClass.update({
      where: { id: pastPower.id },
      data: { status: ClassStatus.COMPLETED },
    });
    await prisma.booking.createMany({
      data: [
        {
          studioId: ares.id,
          scheduledClassId: pastPower.id,
          userId: aresM1.id,
          status: BookingStatus.COMPLETED,
        },
        {
          studioId: ares.id,
          scheduledClassId: pastPower.id,
          userId: aresM2.id,
          status: BookingStatus.COMPLETED,
        },
      ],
    });
    await prisma.attendance.createMany({
      data: [
        {
          studioId: ares.id,
          scheduledClassId: pastPower.id,
          userId: aresM1.id,
          method: CheckInMethod.QR,
          checkedInAt: pastPower.startsAt,
          checkedInByUserId: null,
        },
        {
          studioId: ares.id,
          scheduledClassId: pastPower.id,
          userId: aresM2.id,
          method: CheckInMethod.MANUAL,
          checkedInAt: new Date(pastPower.startsAt.getTime() + 5 * 60 * 1000),
          checkedInByUserId: aresStaff.id,
        },
      ],
    });
  }

  // --- Pilates Toluca ---
  const pilates = await prisma.studio.create({
    data: {
      name: 'Pilates Toluca',
      slug: 'pilates-toluca',
      timezone: 'America/Mexico_City',
      appName: 'Pilates Toluca',
      brandPrimaryColor: '#3d5a40',
      brandSecondaryColor: '#e8e4d9',
      brandLogoUrl: 'https://images.unsplash.com/photo-1518611012118-696072aa579a?w=400',
      supportEmail: 'hola@pilates.demo',
      supportPhone: '+52 55 5555 0300',
      privacyUrl: 'https://example.com/pilates/privacy',
      termsUrl: 'https://example.com/pilates/terms',
      iosBundleId: 'com.pilatestoluca.member',
      androidPackageName: 'com.pilatestoluca.member',
    },
  });

  const ptAdmin = await prisma.user.create({
    data: {
      email: 'admin@pilates.demo',
      firstName: 'Carla',
      lastName: 'Mendoza',
      phone: '+52 55 5555 0312',
      passwordHash,
      stripeCustomerId: 'cus_demo_pt_admin',
    },
  });
  const ptOwner = await prisma.user.create({
    data: {
      email: 'owner@pilates.demo',
      firstName: 'Valentina',
      lastName: 'Ibarra',
      phone: '+52 55 5555 0310',
      passwordHash,
      stripeCustomerId: 'cus_demo_pt_owner',
    },
  });
  const ptInstructor = await prisma.user.create({
    data: {
      email: 'instructor@pilates.demo',
      firstName: 'Mariana',
      lastName: 'Soto',
      phone: '+52 55 5555 0311',
      passwordHash,
      stripeCustomerId: 'cus_demo_pt_instructor',
    },
  });
  const ptM1 = await prisma.user.create({
    data: {
      email: 'member1@pilates.demo',
      firstName: 'Lucía',
      lastName: 'Herrera',
      passwordHash,
      stripeCustomerId: 'cus_demo_pt_m1',
    },
  });
  const ptM2 = await prisma.user.create({
    data: {
      email: 'member2@pilates.demo',
      firstName: 'Diego',
      lastName: 'Ramos',
      passwordHash,
      stripeCustomerId: 'cus_demo_pt_m2',
    },
  });

  await prisma.studioMembership.createMany({
    data: [
      { studioId: pilates.id, userId: ptOwner.id, role: Role.OWNER },
      { studioId: pilates.id, userId: ptAdmin.id, role: Role.ADMIN },
      { studioId: pilates.id, userId: ptInstructor.id, role: Role.INSTRUCTOR },
      { studioId: pilates.id, userId: ptM1.id, role: Role.MEMBER },
      { studioId: pilates.id, userId: ptM2.id, role: Role.MEMBER },
    ],
  });

  const ptReformer = await prisma.membershipPlan.create({
    data: {
      studioId: pilates.id,
      name: 'Reformer Studio Pass',
      description: 'Twelve reformer sessions per month with priority booking for evening slots.',
      priceCents: 249000,
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: 12,
      active: true,
      stripeProductId: 'prod_demo_pt_reformer',
      stripePriceId: 'price_demo_pt_reformer_monthly',
    },
  });
  const ptMat = await prisma.membershipPlan.create({
    data: {
      studioId: pilates.id,
      name: 'Mat Essentials',
      description: 'Unlimited mat classes — perfect if you are new to Pilates or mixing with reformer packs.',
      priceCents: 89000,
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: null,
      active: true,
      stripeProductId: 'prod_demo_pt_mat',
      stripePriceId: 'price_demo_pt_mat_monthly',
    },
  });

  await prisma.subscription.create({
    data: {
      studioId: pilates.id,
      userId: ptM1.id,
      membershipPlanId: ptReformer.id,
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: 'sub_demo_pt_m1_reformer',
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
    },
  });

  await prisma.subscription.create({
    data: {
      studioId: pilates.id,
      userId: ptM2.id,
      membershipPlanId: ptMat.id,
      status: SubscriptionStatus.CANCELED,
      stripeSubscriptionId: 'sub_demo_pt_m2_mat_canceled',
      currentPeriodStart: addDays(now, -120),
      currentPeriodEnd: addDays(now, -14),
      cancelAtPeriodEnd: false,
    },
  });

  const tplReformer = await prisma.classTemplate.create({
    data: {
      studioId: pilates.id,
      name: 'Reformer Flow',
      durationMinutes: 55,
      description: 'Classical order with spring changes — small groups, hands-on cues, and optional progressions.',
      defaultCapacity: 6,
      color: '#5c7f5f',
      defaultInstructorId: ptInstructor.id,
    },
  });
  const tplMat = await prisma.classTemplate.create({
    data: {
      studioId: pilates.id,
      name: 'Mat Fundamentals',
      durationMinutes: 50,
      description: 'Breath, core sequencing, and alignment — ideal for beginners and recovery days.',
      defaultCapacity: 12,
      color: '#8fa68f',
      defaultInstructorId: ptInstructor.id,
    },
  });

  for (let d = 0; d <= 7; d++) {
    const base = addDays(now, d);
    const rStart = atLocalTime(base, 8, 30);
    const rEnd = new Date(rStart.getTime() + 55 * 60 * 1000);
    await prisma.scheduledClass.create({
      data: {
        studioId: pilates.id,
        classTemplateId: tplReformer.id,
        instructorId: ptInstructor.id,
        startsAt: rStart,
        endsAt: rEnd,
        capacity: 6,
        status: ClassStatus.SCHEDULED,
      },
    });
    const mStart = atLocalTime(base, 17, 0);
    const mEnd = new Date(mStart.getTime() + 50 * 60 * 1000);
    await prisma.scheduledClass.create({
      data: {
        studioId: pilates.id,
        classTemplateId: tplMat.id,
        instructorId: ptInstructor.id,
        startsAt: mStart,
        endsAt: mEnd,
        capacity: 12,
        status: ClassStatus.SCHEDULED,
      },
    });
  }

  const ptClass = await prisma.scheduledClass.findFirst({
    where: { studioId: pilates.id, startsAt: { gt: now } },
    orderBy: { startsAt: 'asc' },
  });
  if (ptClass) {
    await prisma.booking.create({
      data: {
        studioId: pilates.id,
        scheduledClassId: ptClass.id,
        userId: ptM1.id,
        status: BookingStatus.CONFIRMED,
      },
    });
  }

  console.log(
    JSON.stringify({
      event: 'demo_seed_complete',
      studios: [ares.slug, pilates.slug],
      demoPasswordDoc: 'docs/DEMO_ENVIRONMENT.md',
    }),
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
