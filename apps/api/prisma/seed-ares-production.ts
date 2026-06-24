/**
 * Ares Training Club — safe production update script.
 *
 * Use this instead of seed.ts when the ares-fitness studio is already live.
 * This script NEVER deletes or modifies:
 *   Studio rows, User rows, StudioMembership rows, Subscription rows,
 *   Payment rows, Booking rows, Attendance rows, QRToken rows.
 *
 * All writes are upserts or existence-checked inserts — safe to re-run.
 *
 * DRY RUN: reads current DB state and logs every operation it would perform,
 * without writing anything.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." pnpm --filter api seed:ares
 *   DATABASE_URL="postgresql://..." DRY_RUN=true pnpm --filter api seed:ares
 */

import {
  BillingInterval,
  ClassCategory,
  ClassStatus,
  IntensityLevel,
  PrismaClient,
  Role,
  StaffType,
} from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = process.env.DRY_RUN === 'true';

const ARES_SLUG = 'ares-fitness';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function log(op: string, entity: string, detail: string): void {
  const prefix = DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]';
  console.log(`${prefix} ${op.padEnd(7)} ${entity.padEnd(22)} ${detail}`);
}

const ARES_TZ = 'America/Mexico_City';

/**
 * Returns the CDMX calendar date (year/month/day) and day-of-week (0=Sun)
 * for any UTC instant, using the America/Mexico_City timezone.
 * Independent of the host machine's local timezone.
 */
function cdmxDateParts(utcInstant: Date): { year: number; month: number; day: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ARES_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(utcInstant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  // getUTCDay() on a UTC-midnight instant is host-timezone-agnostic.
  return { year, month, day, dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

/**
 * Converts an America/Mexico_City wall-clock time to a UTC Date.
 * Mexico City abolished DST in 2023 and is permanently CST = UTC-6.
 * UTC = CDMX local + 6 h. Date.UTC handles hour overflow (e.g. 18+6=24 → next day).
 */
function cdmxToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + 6, minute));
}

/** Mon–Thu: 7 slots. Fri: 5 slots. Sat: 2 slots. Sun: closed. */
function scheduleHoursForDay(dayOfWeek: number): number[] {
  switch (dayOfWeek) {
    case 1: case 2: case 3: case 4:
      return [6, 7, 8, 9, 18, 19, 20];
    case 5:
      return [6, 7, 8, 9, 18];
    case 6:
      return [8, 9];
    default:
      return [];
  }
}

/**
 * Returns true when the value is null or starts with the given placeholder
 * prefix — meaning it was seeded as a fake ID and must be cleared.
 */
function isPlaceholderOrNull(value: string | null, placeholderPrefix: string): boolean {
  return value === null || value.startsWith(placeholderPrefix);
}

// ─── Data definitions ──────────────────────────────────────────────────────────

const COACH_DEFS = [
  {
    email: 'yayo@ares.demo',
    firstName: 'Yayo',
    lastName: 'Rodríguez',
    bio: 'Especialista en fuerza y calistenia. Certif. NSCA-CSCS.',
    specialties: ['Upper Push', 'Street Bars', 'Full Body'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400',
  },
  {
    email: 'coco@ares.demo',
    firstName: 'Coco',
    lastName: 'Herrera',
    bio: 'Coach de funcional y Hyrox. Competidora nivel amateur.',
    specialties: ['Hyrox', 'Calirox', 'Full Body'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1548690312-e3b507d8c110?w=400',
  },
  {
    email: 'karen@ares.demo',
    firstName: 'Karen',
    lastName: 'López',
    bio: 'Entrenadora de fuerza con enfoque en piernas y cadena posterior.',
    specialties: ['Power Legs', 'Full Body', 'Upper Pull'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=400',
  },
  {
    email: 'fer@ares.demo',
    firstName: 'Fer',
    lastName: 'Gutiérrez',
    bio: 'Apasionado del Street Workout y movimiento natural.',
    specialties: ['Street Bars', 'Upper Push', 'Calirox'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=400',
  },
  {
    email: 'estefy@ares.demo',
    firstName: 'Estefy',
    lastName: 'Morales',
    bio: 'Especialista en upper body y programación de fuerza.',
    specialties: ['Upper Push', 'Upper Pull', 'Power Legs'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1579758629938-03607ccdbaba?w=400',
  },
  {
    email: 'mau@ares.demo',
    firstName: 'Mau',
    lastName: 'Jiménez',
    bio: 'Coach de HIIT y rendimiento deportivo. Marathonista.',
    specialties: ['Hyrox', 'Calirox', 'Full Body'] as string[],
    photoUrl: 'https://images.unsplash.com/photo-1594381898411-846e7d193883?w=400',
  },
];

const PLAN_DEFS = [
  {
    name: 'Full Access',
    description:
      'Clases ilimitadas + Open Gym · 11:00 a.m. – 5:00 p.m. + 5 guest passes al mes + tina de hielo + eventos. Sin restricciones de horario.',
    priceCents: 195000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    classCredits: null as number | null,
    allowedCategories: [] as ClassCategory[],
  },
  {
    name: 'Basic Access',
    description:
      '12 clases al mes + Open Gym · 11:00 a.m. – 5:00 p.m. + 3 guest passes. Créditos no acumulables.',
    priceCents: 130000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    classCredits: 12 as number | null,
    allowedCategories: [] as ClassCategory[],
  },
  {
    name: 'Hyrox',
    description:
      '3 sesiones Hyrox por semana + plan de carrera semanal + running club + Open Gym + tina de hielo. No incluye clases regulares.',
    priceCents: 200000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    classCredits: 12 as number | null,
    allowedCategories: [ClassCategory.HYROX] as ClassCategory[],
  },
  {
    name: 'Elite',
    description:
      'Full Access + Hyrox + Open Gym + tina de hielo + eventos + programa de running + guest passes ilimitados.',
    priceCents: 295000,
    currency: 'mxn',
    billingInterval: BillingInterval.MONTHLY,
    classCredits: null as number | null,
    allowedCategories: [] as ClassCategory[],
  },
];

const TEMPLATE_DEFS = [
  {
    name: 'Upper Push',
    description: 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.',
    duration: 60,
    color: '#c9a227',
    category: ClassCategory.STRENGTH,
    intensity: IntensityLevel.HIGH,
    heroImageUrl: 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=800',
  },
  {
    name: 'Upper Pull',
    description: 'Rutina enfocada al grupo muscular seleccionado por día. ARES Method.',
    duration: 60,
    color: '#0f172a',
    category: ClassCategory.STRENGTH,
    intensity: IntensityLevel.HIGH,
    heroImageUrl: 'https://images.unsplash.com/photo-1530822847156-5df684ec5933?w=800',
  },
  {
    name: 'Full Body',
    description: 'Trabajo completo de tren superior e inferior en circuito. Alta densidad, descanso guiado.',
    duration: 60,
    color: '#ef4444',
    category: ClassCategory.STRENGTH,
    intensity: IntensityLevel.HIGH,
    heroImageUrl: 'https://images.unsplash.com/photo-1534258936925-c58bed479fcb?w=800',
  },
  {
    name: 'Power Legs',
    description: 'Sentadillas, peso muerto, Bulgarian split y variantes. Fuerza de pierna y glúteo con técnica.',
    duration: 60,
    color: '#8b5cf6',
    category: ClassCategory.STRENGTH,
    intensity: IntensityLevel.HIGH,
    heroImageUrl: 'https://images.unsplash.com/photo-1574680096145-d05b474e2155?w=800',
  },
  {
    name: 'Calirox',
    description: 'Un festín entre calistenia y Hyrox. En Calirox encontrarás un entrenamiento basado en fuerza y control corporal combinado con la resistencia y funcionalidad de Hyrox. Sin duda, uno de los favoritos.',
    duration: 45,
    color: '#f97316',
    category: ClassCategory.HIIT,
    intensity: IntensityLevel.EXTREME,
    heroImageUrl: 'https://images.unsplash.com/photo-1598971861713-54ad16a7e72e?w=800',
  },
  {
    name: 'Hyrox',
    description: 'Sesiones personalizadas enfocadas totalmente en las estaciones de Hyrox. Aprenderás a mejorar tu tiempo y eficientar la ejecución de cada ejercicio.',
    duration: 60,
    color: '#06b6d4',
    category: ClassCategory.HYROX,
    intensity: IntensityLevel.EXTREME,
    heroImageUrl: 'https://images.unsplash.com/photo-1549576490-b0b4831ef60a?w=800',
  },
  {
    name: 'Street Bars',
    description: 'Clase 100% enfocada en técnica y mejora de tu fuerza y control corporal. Aprenderás a controlar tu cuerpo y su fuerza.',
    duration: 60,
    color: '#10b981',
    category: ClassCategory.STRENGTH,
    intensity: IntensityLevel.HIGH,
    heroImageUrl: 'https://images.unsplash.com/photo-1598971861713-54ad16a7e72e?w=800',
  },
];

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log('════════════════════════════════════════════════');
    console.log('  DRY RUN — zero writes will occur');
    console.log('  Reads current DB state to simulate all ops.');
    console.log('════════════════════════════════════════════════\n');
  }

  // ── 1. Locate the ARES studio (must already exist in production) ─────────
  const studio = await prisma.studio.findUniqueOrThrow({
    where: { slug: ARES_SLUG },
    select: { id: true, slug: true },
  });
  console.log(`Studio found: ${studio.slug} (${studio.id})\n`);

  // ── 2. Update studio metadata ────────────────────────────────────────────
  log('UPDATE', 'Studio', ARES_SLUG);
  if (!DRY_RUN) {
    await prisma.studio.update({
      where: { id: studio.id },
      data: {
        name: 'Ares Training Club',
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
  }

  // ── 3. Upsert coaches ────────────────────────────────────────────────────
  console.log('');
  const coachIds: string[] = [];

  for (let i = 0; i < COACH_DEFS.length; i++) {
    const def = COACH_DEFS[i];

    // User — unique on email. Never sets passwordHash or stripeCustomerId for
    // existing accounts; only firstName/lastName are reconciled.
    log('UPSERT', 'User', def.email);
    let userId: string;
    if (!DRY_RUN) {
      const user = await prisma.user.upsert({
        where: { email: def.email },
        create: { email: def.email, firstName: def.firstName, lastName: def.lastName },
        update: { firstName: def.firstName, lastName: def.lastName },
        select: { id: true },
      });
      userId = user.id;
    } else {
      const existing = await prisma.user.findUnique({
        where: { email: def.email },
        select: { id: true },
      });
      userId = existing?.id ?? `dry-run-coach-${i}`;
    }
    coachIds.push(userId);

    // StudioMembership — @@unique([userId, studioId])
    log('UPSERT', 'StudioMembership', `${def.firstName} → INSTRUCTOR`);
    if (!DRY_RUN) {
      await prisma.studioMembership.upsert({
        where: { userId_studioId: { userId, studioId: studio.id } },
        create: { studioId: studio.id, userId, role: Role.INSTRUCTOR },
        update: { role: Role.INSTRUCTOR },
      });
    }

    // StudioStaffProfile — @@unique([studioId, userId])
    log('UPSERT', 'StudioStaffProfile', def.firstName);
    if (!DRY_RUN) {
      await prisma.studioStaffProfile.upsert({
        where: { studioId_userId: { studioId: studio.id, userId } },
        create: {
          studioId: studio.id,
          userId,
          staffType: StaffType.COACH,
          bio: def.bio,
          specialties: def.specialties,
          photoUrl: def.photoUrl,
          isActive: true,
        },
        update: {
          staffType: StaffType.COACH,
          bio: def.bio,
          specialties: def.specialties,
          photoUrl: def.photoUrl,
          isActive: true,
        },
      });
    }
  }

  if (coachIds.length === 0) {
    throw new Error('No coach IDs resolved. Cannot continue.');
  }

  // ── 4. Upsert membership plans ───────────────────────────────────────────
  console.log('');
  for (const def of PLAN_DEFS) {
    const existing = await prisma.membershipPlan.findFirst({
      where: { studioId: studio.id, name: def.name, deletedAt: null },
      select: { id: true, stripeProductId: true, stripePriceId: true },
    });

    if (existing) {
      // Only null out Stripe IDs that are placeholders (prefixed with fake seeds)
      // or already null. Real Stripe IDs (prod_abc123) are never touched.
      const needsStripeClear =
        isPlaceholderOrNull(existing.stripeProductId, 'prod_ares_') ||
        isPlaceholderOrNull(existing.stripePriceId, 'price_ares_');

      log(
        'UPDATE',
        'MembershipPlan',
        `"${def.name}"${needsStripeClear ? ' — clearing placeholder Stripe IDs' : ' — keeping Stripe IDs'}`,
      );
      if (!DRY_RUN) {
        await prisma.membershipPlan.update({
          where: { id: existing.id },
          data: {
            description: def.description,
            priceCents: def.priceCents,
            currency: def.currency,
            classCredits: def.classCredits,
            allowedCategories: def.allowedCategories,
            active: true,
            ...(needsStripeClear ? { stripeProductId: null, stripePriceId: null } : {}),
          },
        });
      }
    } else {
      log('CREATE', 'MembershipPlan', `"${def.name}" — stripeProductId=null stripePriceId=null`);
      if (!DRY_RUN) {
        await prisma.membershipPlan.create({
          data: {
            studioId: studio.id,
            name: def.name,
            description: def.description,
            priceCents: def.priceCents,
            currency: def.currency,
            billingInterval: def.billingInterval,
            classCredits: def.classCredits,
            allowedCategories: def.allowedCategories,
            active: true,
            stripeProductId: null,
            stripePriceId: null,
          },
        });
      }
    }
  }

  // ── 5. Upsert class templates ────────────────────────────────────────────
  console.log('');
  const resolvedTemplates: { id: string; duration: number }[] = [];

  for (let i = 0; i < TEMPLATE_DEFS.length; i++) {
    const def = TEMPLATE_DEFS[i];
    const isFeatured = i < 3;

    const existing = await prisma.classTemplate.findFirst({
      where: { studioId: studio.id, name: def.name, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      log('UPDATE', 'ClassTemplate', `"${def.name}"`);
      if (!DRY_RUN) {
        await prisma.classTemplate.update({
          where: { id: existing.id },
          data: {
            description: def.description,
            durationMinutes: def.duration,
            defaultCapacity: 25,
            color: def.color,
            category: def.category,
            intensityLevel: def.intensity,
            heroImageUrl: def.heroImageUrl,
            isFeatured,
          },
        });
      }
      resolvedTemplates.push({ id: existing.id, duration: def.duration });
    } else {
      log('CREATE', 'ClassTemplate', `"${def.name}"`);
      let newId = `dry-run-template-${i}`;
      if (!DRY_RUN) {
        const defaultInstructorId = coachIds[i % coachIds.length] ?? null;
        const tpl = await prisma.classTemplate.create({
          data: {
            studioId: studio.id,
            name: def.name,
            description: def.description,
            durationMinutes: def.duration,
            defaultCapacity: 25,
            color: def.color,
            category: def.category,
            intensityLevel: def.intensity,
            heroImageUrl: def.heroImageUrl,
            isFeatured,
            defaultInstructorId,
          },
          select: { id: true },
        });
        newId = tpl.id;
      }
      resolvedTemplates.push({ id: newId, duration: def.duration });
    }
  }

  if (resolvedTemplates.length === 0) {
    throw new Error('No class templates resolved. Cannot build schedule.');
  }

  // ── 6. Create future scheduled classes (idempotent, no duplicates) ────────
  console.log('');
  const now = new Date();
  let classesCreated = 0;
  let classesSkipped = 0;
  let slotIndex = 0;

  // Anchor on today's CDMX calendar date — host-timezone-agnostic.
  const { year: y0, month: m0, day: d0 } = cdmxDateParts(now);
  // CDMX midnight = UTC 06:00 (UTC-6, fixed since 2023 DST abolition).
  const cdmxMidnightDay0 = new Date(Date.UTC(y0, m0 - 1, d0, 6, 0));

  for (let d = 0; d < 14; d++) {
    // Adding d × 24 h is safe: no DST transitions in Mexico City since 2023.
    const cdmxMidnight = new Date(cdmxMidnightDay0.getTime() + d * 24 * 60 * 60 * 1000);
    const { year, month, day, dow } = cdmxDateParts(cdmxMidnight);
    const hours = scheduleHoursForDay(dow);

    for (const hour of hours) {
      const startsAt = cdmxToUtc(year, month, day, hour, 0);

      // Never create classes in the past or at this exact moment
      if (startsAt <= now) {
        slotIndex++;
        continue;
      }

      const tpl = resolvedTemplates[slotIndex % resolvedTemplates.length];
      const instructorId = coachIds[slotIndex % coachIds.length];
      const endsAt = new Date(startsAt.getTime() + tpl.duration * 60 * 1000);

      // Existence check: same studio + template + instructor + start time = duplicate
      const duplicate = await prisma.scheduledClass.findFirst({
        where: { studioId: studio.id, classTemplateId: tpl.id, instructorId, startsAt },
        select: { id: true },
      });

      if (duplicate) {
        log('SKIP', 'ScheduledClass', `${startsAt.toISOString().slice(0, 16)} (already exists)`);
        classesSkipped++;
      } else {
        log('CREATE', 'ScheduledClass', `${startsAt.toISOString().slice(0, 16)}`);
        if (!DRY_RUN) {
          await prisma.scheduledClass.create({
            data: {
              studioId: studio.id,
              classTemplateId: tpl.id,
              instructorId,
              startsAt,
              endsAt,
              capacity: 25,
              status: ClassStatus.SCHEDULED,
            },
          });
        }
        classesCreated++;
      }

      slotIndex++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(
    JSON.stringify(
      {
        event: 'seed_ares_production_complete',
        studio: ARES_SLUG,
        dry_run: DRY_RUN,
        coaches_upserted: COACH_DEFS.length,
        plans_processed: PLAN_DEFS.length,
        templates_processed: TEMPLATE_DEFS.length,
        classes_created: classesCreated,
        classes_skipped_existing: classesSkipped,
        data_never_touched: [
          'Studio (delete)',
          'User (delete)',
          'StudioMembership (delete)',
          'Subscription',
          'Payment',
          'Booking',
          'Attendance',
          'QRToken',
        ],
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
