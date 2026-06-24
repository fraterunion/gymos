/**
 * GymOS pilot seed — Ares Training Club & Pilates Toluca.
 * Idempotent for re-runs: clears prior demo studios/users (see DEMO_SLUGS / demo email domains).
 *
 * Shared demo password: see docs/DEMO_ENVIRONMENT.md (not a production secret).
 *
 * KNOWN LIMITATIONS (document only, do not hack):
 *   Day Pass ($200 MXN) and Inscripción ($700 MXN) are one-time fees.
 *   The MembershipPlan model only supports MONTHLY / YEARLY / WEEKLY billing intervals.
 *   These must be handled outside the subscription flow (Stripe Payment Links, manual invoices,
 *   or a future one-time purchase model). They are NOT seeded here.
 *
 *   Hyrox membership excludes regular classes — this access restriction is not enforced
 *   at the booking layer today. The description communicates it; enforcement requires a
 *   membership-plan-to-class-template mapping feature (future phase).
 *
 *   Open Gym (11 am–10 pm) is an unstructured facility access benefit, not a bookable class.
 *   It is included in plan descriptions only; no ScheduledClass is created for it.
 */
import {
  BillingInterval,
  BookingStatus,
  CancelSource,
  CheckInMethod,
  ClassCategory,
  ClassStatus,
  IntensityLevel,
  PaymentStatus,
  PrismaClient,
  Role,
  StaffType,
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

/** Mon–Thu: 7 slots. Fri: 5 slots. Sat: 2 slots. Sun: closed. */
function scheduleHoursForDay(dayOfWeek: number): number[] {
  switch (dayOfWeek) {
    case 1: // Monday
    case 2: // Tuesday
    case 3: // Wednesday
    case 4: // Thursday
      return [6, 7, 8, 9, 18, 19, 20];
    case 5: // Friday
      return [6, 7, 8, 9, 18];
    case 6: // Saturday
      return [8, 9];
    default: // Sunday — no regular classes
      return [];
  }
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
    await prisma.studioStaffProfile.deleteMany({ where: { studioId: { in: studioIds } } });
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

  // ─── Ares Training Club ──────────────────────────────────────────────────────────

  const ares = await prisma.studio.create({
    data: {
      name: 'Ares Training Club',
      slug: 'ares-fitness',
      timezone: 'America/Mexico_City',
      appName: 'Ares Training Club',
      appDisplayName: 'Ares Training Club',
      brandPrimaryColor: '#0f172a',
      brandSecondaryColor: '#c9a227',
      brandLogoUrl: 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=400',
      supportEmail: 'hello@aresfitness.mx',
      supportPhone: '+52 55 0000 0000',
      privacyUrl: 'https://aresfitness.mx/privacidad',
      termsUrl: 'https://aresfitness.mx/terminos',
      iosBundleId: 'com.fraterunion.aresfitness',
      androidPackageName: 'com.fraterunion.aresfitness',
    },
  });

  // Admin + staff
  const aresAdmin = await prisma.user.create({
    data: {
      email: 'admin@ares.demo',
      firstName: 'Administrador',
      lastName: 'ARES',
      phone: '+52 55 0000 0001',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_admin',
    },
  });
  const aresStaff = await prisma.user.create({
    data: {
      email: 'staff@ares.demo',
      firstName: 'Recepción',
      lastName: 'ARES',
      phone: '+52 55 0000 0002',
      passwordHash,
      stripeCustomerId: 'cus_demo_ares_staff',
    },
  });

  // Coaches
  const coachDefs = [
    { email: 'yayo@ares.demo',   firstName: 'Yayo',   lastName: 'Rodríguez', bio: 'Especialista en fuerza y calistenia. Certif. NSCA-CSCS.', specialties: ['Upper Push', 'Street Bars', 'Full Body'] },
    { email: 'coco@ares.demo',   firstName: 'Coco',   lastName: 'Herrera',   bio: 'Coach de funcional y Hyrox. Competidora nivel amateur.', specialties: ['Hyrox', 'Calirox', 'Full Body'] },
    { email: 'karen@ares.demo',  firstName: 'Karen',  lastName: 'López',     bio: 'Entrenadora de fuerza con enfoque en piernas y cadena posterior.', specialties: ['Power Legs', 'Full Body', 'Upper Pull'] },
    { email: 'fer@ares.demo',    firstName: 'Fer',    lastName: 'Gutiérrez', bio: 'Apasionado del Street Workout y movimiento natural.', specialties: ['Street Bars', 'Upper Push', 'Calirox'] },
    { email: 'estefy@ares.demo', firstName: 'Estefy', lastName: 'Morales',   bio: 'Especialista en upper body y programación de fuerza.', specialties: ['Upper Push', 'Upper Pull', 'Power Legs'] },
    { email: 'mau@ares.demo',    firstName: 'Mau',    lastName: 'Jiménez',   bio: 'Coach de HIIT y rendimiento deportivo. Marathonista.', specialties: ['Hyrox', 'Calirox', 'Full Body'] },
  ] as const;

  const coachPhotoUrls = [
    'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400',
    'https://images.unsplash.com/photo-1548690312-e3b507d8c110?w=400',
    'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=400',
    'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400',
    'https://images.unsplash.com/photo-1579758629938-03607ccdbaba?w=400',
    'https://images.unsplash.com/photo-1594381898411-846e7d193883?w=400',
  ];

  const coaches: { id: string }[] = [];
  for (let i = 0; i < coachDefs.length; i++) {
    const def = coachDefs[i];
    const user = await prisma.user.create({
      data: {
        email: def.email,
        firstName: def.firstName,
        lastName: def.lastName,
        passwordHash,
        stripeCustomerId: `cus_demo_ares_coach_${i + 1}`,
      },
    });
    coaches.push({ id: user.id });
    await prisma.studioMembership.create({
      data: { studioId: ares.id, userId: user.id, role: Role.INSTRUCTOR },
    });
    await prisma.studioStaffProfile.create({
      data: {
        studioId: ares.id,
        userId: user.id,
        staffType: StaffType.COACH,
        bio: def.bio,
        specialties: [...def.specialties],
        photoUrl: coachPhotoUrls[i],
        isActive: true,
      },
    });
  }

  // Demo members (subscriptions + bookings for QA)
  const aresM1 = await prisma.user.create({ data: { email: 'member1@ares.demo', firstName: 'Ana', lastName: 'Sánchez', passwordHash, stripeCustomerId: 'cus_demo_ares_m1' } });
  const aresM2 = await prisma.user.create({ data: { email: 'member2@ares.demo', firstName: 'Luis', lastName: 'Torres', passwordHash, stripeCustomerId: 'cus_demo_ares_m2' } });
  const aresM3 = await prisma.user.create({ data: { email: 'member3@ares.demo', firstName: 'Sofía', lastName: 'Ramírez', passwordHash, stripeCustomerId: 'cus_demo_ares_m3' } });

  const memberRoles = [
    { userId: aresAdmin.id, role: Role.ADMIN },
    { userId: aresStaff.id, role: Role.STAFF },
    { userId: aresM1.id, role: Role.MEMBER },
    { userId: aresM2.id, role: Role.MEMBER },
    { userId: aresM3.id, role: Role.MEMBER },
  ];
  await prisma.studioMembership.createMany({
    data: memberRoles.map((r) => ({ studioId: ares.id, userId: r.userId, role: r.role })),
  });

  // ─── Membership plans (MXN) ─────────────────────────────────────────────
  // NOTE: Day Pass ($200 MXN) and Inscripción ($700 MXN) are one-time fees not
  // supported by the recurring MembershipPlan model. Handle via Stripe Payment Links.

  const planFullAccess = await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Full Access',
      description:
        'Clases ilimitadas + Open Gym · 11:00 a.m. – 5:00 p.m. + 5 guest passes al mes + tina de hielo + eventos. Sin restricciones de horario.',
      priceCents: 195000, // $1,950 MXN
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: null,
      active: true,
      stripeProductId: null,
      stripePriceId: null,
    },
  });

  const planBasicAccess = await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Basic Access',
      description:
        '12 clases al mes + Open Gym · 11:00 a.m. – 5:00 p.m. + 3 guest passes. Créditos no acumulables.',
      priceCents: 130000, // $1,300 MXN
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: 12,
      active: true,
      stripeProductId: null,
      stripePriceId: null,
    },
  });

  await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Hyrox',
      description:
        '3 sesiones Hyrox por semana + plan de carrera semanal + running club + Open Gym + tina de hielo. No incluye clases regulares.',
      priceCents: 200000, // $2,000 MXN
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: 12, // ~3 sessions/week
      active: true,
      stripeProductId: null,
      stripePriceId: null,
    },
  });

  await prisma.membershipPlan.create({
    data: {
      studioId: ares.id,
      name: 'Elite',
      description:
        'Full Access + Hyrox + Open Gym + tina de hielo + eventos + programa de running + guest passes ilimitados.',
      priceCents: 295000, // $2,950 MXN
      currency: 'mxn',
      billingInterval: BillingInterval.MONTHLY,
      classCredits: null,
      active: true,
      stripeProductId: null,
      stripePriceId: null,
    },
  });

  // ─── Class templates ─────────────────────────────────────────────────────

  const templateDefs = [
    {
      name: 'Upper Push',
      description: 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.',
      duration: 60, color: '#c9a227', category: ClassCategory.STRENGTH, intensity: IntensityLevel.HIGH,
      heroImageUrl: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800',
    },
    {
      name: 'Upper Pull',
      description: 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.',
      duration: 60, color: '#0f172a', category: ClassCategory.STRENGTH, intensity: IntensityLevel.HIGH,
      heroImageUrl: 'https://images.unsplash.com/photo-1530822847156-5df684ec5933?w=800',
    },
    {
      name: 'Full Body',
      description: 'Trabajo completo de tren superior e inferior en circuito. Alta densidad, descanso guiado.',
      duration: 60, color: '#ef4444', category: ClassCategory.STRENGTH, intensity: IntensityLevel.HIGH,
      heroImageUrl: 'https://images.unsplash.com/photo-1534258936925-c58bed479fcb?w=800',
    },
    {
      name: 'Power Legs',
      description: 'Sentadillas, peso muerto, Bulgarian split y variantes. Fuerza de pierna y glúteo con técnica.',
      duration: 60, color: '#8b5cf6', category: ClassCategory.STRENGTH, intensity: IntensityLevel.HIGH,
      heroImageUrl: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=800',
    },
    {
      name: 'Calirox',
      description: 'Un festín entre calistenia y Hyrox. En Calirox encontrarás un entrenamiento basado en fuerza y control corporal combinado con la resistencia y funcionalidad de Hyrox. Sin duda, uno de los favoritos.',
      duration: 45, color: '#f97316', category: ClassCategory.HIIT, intensity: IntensityLevel.EXTREME,
      heroImageUrl: 'https://images.unsplash.com/photo-1598971861713-54ad16a7e72e?w=800',
    },
    {
      name: 'Hyrox',
      description: 'Sesiones personalizadas enfocadas totalmente en las estaciones de Hyrox. Aprenderás a mejorar tu tiempo y eficientar la ejecución de cada ejercicio.',
      duration: 60, color: '#06b6d4', category: ClassCategory.HIIT, intensity: IntensityLevel.EXTREME,
      heroImageUrl: 'https://images.unsplash.com/photo-1549576490-b0b4831ef60a?w=800',
    },
    {
      name: 'Street Bars',
      description: 'Clase 100% enfocada en técnica y mejora de tu fuerza y control corporal. Aprenderás a controlar tu cuerpo y su fuerza.',
      duration: 60, color: '#10b981', category: ClassCategory.STRENGTH, intensity: IntensityLevel.HIGH,
      heroImageUrl: 'https://images.unsplash.com/photo-1598971861713-54ad16a7e72e?w=800',
    },
  ] as const;

  const templates: { id: string }[] = [];
  for (let i = 0; i < templateDefs.length; i++) {
    const def = templateDefs[i];
    const defaultInstructor = coaches[i % coaches.length];
    const tpl = await prisma.classTemplate.create({
      data: {
        studioId: ares.id,
        name: def.name,
        description: def.description,
        durationMinutes: def.duration,
        defaultCapacity: 25,
        color: def.color,
        category: def.category,
        intensityLevel: def.intensity,
        heroImageUrl: def.heroImageUrl,
        isFeatured: i < 3, // first 3 are featured
        defaultInstructorId: defaultInstructor.id,
      },
    });
    templates.push({ id: tpl.id });
  }

  // ─── 14-day schedule (Mon–Thu: 7 slots, Fri: 5, Sat: 2, Sun: closed) ────

  let slotIndex = 0;
  const scheduledAres: { id: string; startsAt: Date; templateId: string; isFirst: boolean }[] = [];

  for (let d = 0; d < 14; d++) {
    const base = addDays(now, d);
    const dayOfWeek = base.getDay();
    const hours = scheduleHoursForDay(dayOfWeek);
    if (hours.length === 0) continue;

    for (const hour of hours) {
      const template = templates[slotIndex % templates.length];
      const coach = coaches[slotIndex % coaches.length];
      const def = templateDefs[slotIndex % templateDefs.length];
      const startsAt = atLocalTime(base, hour, 0);
      const endsAt = new Date(startsAt.getTime() + def.duration * 60 * 1000);
      const sc = await prisma.scheduledClass.create({
        data: {
          studioId: ares.id,
          classTemplateId: template.id,
          instructorId: coach.id,
          startsAt,
          endsAt,
          capacity: 25,
          status: ClassStatus.SCHEDULED,
        },
      });
      scheduledAres.push({
        id: sc.id,
        startsAt,
        templateId: template.id,
        isFirst: slotIndex === 0,
      });
      slotIndex++;
    }
  }

  // ─── Demo subscriptions ──────────────────────────────────────────────────

  const periodStart = addDays(now, -5);
  const periodEnd = addDays(now, 25);

  await prisma.subscription.createMany({
    data: [
      {
        studioId: ares.id,
        userId: aresM1.id,
        membershipPlanId: planFullAccess.id,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: 'sub_demo_ares_m1_full',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
      {
        studioId: ares.id,
        userId: aresM2.id,
        membershipPlanId: planBasicAccess.id,
        status: SubscriptionStatus.ACTIVE,
        stripeSubscriptionId: 'sub_demo_ares_m2_basic',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
      },
      {
        studioId: ares.id,
        userId: aresM3.id,
        membershipPlanId: planBasicAccess.id,
        status: SubscriptionStatus.PAST_DUE,
        stripeSubscriptionId: 'sub_demo_ares_m3_basic_pastdue',
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
      amountCents: 195000,
      currency: 'mxn',
      status: PaymentStatus.SUCCEEDED,
      stripePaymentIntentId: 'pi_demo_ares_m1_001',
      stripeInvoiceId: 'in_demo_ares_m1_001',
    },
  });

  // ─── Demo bookings (QA scenario: near-capacity class, waitlist) ──────────

  const nearFutureClass = scheduledAres.find((c) => c.startsAt > now);
  if (nearFutureClass) {
    // Reduce capacity to create a full-class demo scenario
    await prisma.scheduledClass.update({
      where: { id: nearFutureClass.id },
      data: { capacity: 3 },
    });
    await prisma.booking.createMany({
      data: [
        { studioId: ares.id, scheduledClassId: nearFutureClass.id, userId: aresM1.id, status: BookingStatus.CONFIRMED },
        { studioId: ares.id, scheduledClassId: nearFutureClass.id, userId: aresM2.id, status: BookingStatus.CONFIRMED },
        { studioId: ares.id, scheduledClassId: nearFutureClass.id, userId: aresM3.id, status: BookingStatus.CONFIRMED },
      ],
    });
    await prisma.waitlistEntry.create({
      data: {
        studioId: ares.id,
        scheduledClassId: nearFutureClass.id,
        userId: coaches[0].id,
        status: WaitlistStatus.WAITING,
        position: 1,
      },
    });
  }

  // Demo past attendance
  const pastClass = scheduledAres
    .filter((c) => c.startsAt < now)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0];
  if (pastClass) {
    await prisma.scheduledClass.update({ where: { id: pastClass.id }, data: { status: ClassStatus.COMPLETED } });
    await prisma.booking.createMany({
      data: [
        { studioId: ares.id, scheduledClassId: pastClass.id, userId: aresM1.id, status: BookingStatus.COMPLETED },
        { studioId: ares.id, scheduledClassId: pastClass.id, userId: aresM2.id, status: BookingStatus.COMPLETED },
      ],
    });
    await prisma.attendance.createMany({
      data: [
        {
          studioId: ares.id,
          scheduledClassId: pastClass.id,
          userId: aresM1.id,
          method: CheckInMethod.QR,
          checkedInAt: pastClass.startsAt,
          checkedInByUserId: null,
        },
        {
          studioId: ares.id,
          scheduledClassId: pastClass.id,
          userId: aresM2.id,
          method: CheckInMethod.MANUAL,
          checkedInAt: new Date(pastClass.startsAt.getTime() + 3 * 60 * 1000),
          checkedInByUserId: aresStaff.id,
        },
      ],
    });
  }

  // ─── Pilates Toluca ───────────────────────────────────────────────────────

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

  const ptPeriodStart = addDays(now, -5);
  const ptPeriodEnd = addDays(now, 25);

  await prisma.subscription.create({
    data: {
      studioId: pilates.id,
      userId: ptM1.id,
      membershipPlanId: ptReformer.id,
      status: SubscriptionStatus.ACTIVE,
      stripeSubscriptionId: 'sub_demo_pt_m1_reformer',
      currentPeriodStart: ptPeriodStart,
      currentPeriodEnd: ptPeriodEnd,
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
      event: 'seed_complete',
      studios: [ares.slug, pilates.slug],
      ares_coaches: coachDefs.map((c) => c.firstName),
      ares_plans: ['Full Access', 'Basic Access', 'Hyrox', 'Elite'],
      ares_templates: templateDefs.map((t) => t.name),
      unsupported_one_time_fees: ['Day Pass ($200 MXN)', 'Inscripción ($700 MXN)'],
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
