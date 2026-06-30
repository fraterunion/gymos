/**
 * ARES 1.3 — Real weekly schedule migration.
 *
 * SAFE BY DEFAULT: DRY_RUN unless LIVE_RUN=true.
 * Cancelling classes with active bookings requires APPROVE_CANCEL_WITH_BOOKINGS=true.
 *
 * Usage:
 *   DATABASE_URL="..." pnpm --filter api migrate:ares-1.3-schedule
 *   DATABASE_URL="..." LIVE_RUN=true pnpm --filter api migrate:ares-1.3-schedule
 *   DATABASE_URL="..." LIVE_RUN=true APPROVE_CANCEL_WITH_BOOKINGS=true pnpm --filter api migrate:ares-1.3-schedule
 */

import {
  BookingStatus,
  ClassCategory,
  ClassStatus,
  IntensityLevel,
  PrismaClient,
} from '@prisma/client';
import {
  addDaysToDateKey,
  getDayOfWeekFromDateKey,
  getStudioLocalDateKey,
  studioLocalTimeToUtc,
} from '../src/common/date/studio-local-date';
import {
  ARES_ADHOC_TEMPLATE_NAMES,
  ARES_GENERATE_THROUGH,
  ARES_MIGRATION_CANCEL_REASON,
  ARES_NEW_TEMPLATES,
  ARES_SLUG,
  ARES_TEMPLATE_RENAMES,
  ARES_TZ,
  ARES_WEEKLY_SCHEDULE,
  OPEN_GYM_BENEFIT_PREFIX,
  expectedClassesPerWeek,
  totalWeeklyTemplateSlots,
} from '../src/schedule-generator/ares-1.3-schedule-pattern';

const prisma = new PrismaClient();
const DRY_RUN = process.env.LIVE_RUN !== 'true';
const APPROVE_BOOKINGS = process.env.APPROVE_CANCEL_WITH_BOOKINGS === 'true';

const OPEN_GYM_OLD = '11:00 a.m. – 5:00 p.m.';
const OPEN_GYM_NEW = '10:00 a.m. – 5:00 p.m.';

function log(op: string, entity: string, detail: string): void {
  console.log(`${DRY_RUN ? '[DRY_RUN]' : '[WRITE  ]'} ${op.padEnd(10)} ${entity.padEnd(22)} ${detail}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 58 - title.length))}`);
}

function padTime(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${h!.padStart(2, '0')}:${m!.padStart(2, '0')}`;
}

function slotKey(dateKey: string, startTime: string, templateName: string): string {
  return `${dateKey}|${padTime(startTime)}|${templateName}`;
}

type TemplateMap = Map<string, string>;

async function resolveTemplateMap(studioId: string): Promise<TemplateMap> {
  const rows = await prisma.classTemplate.findMany({
    where: { studioId, deletedAt: null },
    select: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.name, r.id]));
}

async function renameTemplateIfSafe(
  studioId: string,
  from: string,
  to: string,
  templateMap: TemplateMap,
): Promise<'RENAMED' | 'SKIP_EXISTS' | 'SKIP_MISSING'> {
  if (templateMap.has(to)) {
    log('SKIP', 'ClassTemplate', `"${from}" → "${to}" (target name already exists)`);
    return 'SKIP_EXISTS';
  }
  const id = templateMap.get(from);
  if (!id) {
    log('SKIP', 'ClassTemplate', `"${from}" not found for rename`);
    return 'SKIP_MISSING';
  }
  log('RENAME', 'ClassTemplate', `"${from}" → "${to}"`);
  if (!DRY_RUN) {
    await prisma.classTemplate.update({ where: { id }, data: { name: to } });
  }
  templateMap.delete(from);
  templateMap.set(to, id);
  return 'RENAMED';
}

async function createTemplateIfMissing(
  studioId: string,
  def: (typeof ARES_NEW_TEMPLATES)[number],
  templateMap: TemplateMap,
): Promise<'CREATED' | 'EXISTS'> {
  if (templateMap.has(def.name)) {
    log('SKIP', 'ClassTemplate', `"${def.name}" already exists`);
    return 'EXISTS';
  }

  let base = def.cloneFrom
    ? await prisma.classTemplate.findFirst({
        where: { studioId, name: def.cloneFrom, deletedAt: null },
      })
    : null;

  if (!base && def.cloneFrom) {
    const renamedId = templateMap.get(
      ARES_TEMPLATE_RENAMES.find((r) => r.from === def.cloneFrom)?.to ?? def.cloneFrom,
    );
    if (renamedId) {
      base = await prisma.classTemplate.findFirst({ where: { id: renamedId } });
    }
  }

  log('CREATE', 'ClassTemplate', `"${def.name}"${def.cloneFrom ? ` (clone from ${def.cloneFrom})` : ''}`);
  if (!DRY_RUN) {
    const created = await prisma.classTemplate.create({
      data: {
        studioId,
        name: def.name,
        description: def.description,
        durationMinutes: def.durationMinutes,
        defaultCapacity: base?.defaultCapacity ?? 25,
        color: def.color,
        category: base?.category ?? ClassCategory.STRENGTH,
        intensityLevel: base?.intensityLevel ?? IntensityLevel.HIGH,
        heroImageUrl: base?.heroImageUrl ?? null,
        defaultInstructorId: base?.defaultInstructorId ?? null,
      },
      select: { id: true },
    });
    templateMap.set(def.name, created.id);
  } else {
    templateMap.set(def.name, `dry-run-${def.name}`);
  }
  return 'CREATED';
}

async function updateOpenGymPlanCopy(studioId: string): Promise<number> {
  const plans = await prisma.membershipPlan.findMany({
    where: { studioId, deletedAt: null },
    select: { id: true, name: true, description: true },
  });
  let updated = 0;
  for (const plan of plans) {
    if (!plan.description?.includes(OPEN_GYM_OLD)) continue;
    const next = plan.description.replaceAll(OPEN_GYM_OLD, OPEN_GYM_NEW);
    log('UPDATE', 'MembershipPlan', `"${plan.name}" Open Gym copy → ${OPEN_GYM_BENEFIT_PREFIX}`);
    if (!DRY_RUN) {
      await prisma.membershipPlan.update({ where: { id: plan.id }, data: { description: next } });
    }
    updated++;
  }
  return updated;
}

function buildExpectedSlots(
  templateMap: TemplateMap,
  fromDateKey: string,
  throughDateKey: string,
): Set<string> {
  const expected = new Set<string>();
  let cursor = fromDateKey;
  while (cursor <= throughDateKey) {
    const dow = getDayOfWeekFromDateKey(cursor);
    for (const day of ARES_WEEKLY_SCHEDULE) {
      if (day.dayOfWeek !== dow) continue;
      if (!templateMap.has(day.classTemplateName)) continue;
      for (const t of day.startTimes) {
        expected.add(slotKey(cursor, t, day.classTemplateName));
      }
    }
    cursor = addDaysToDateKey(cursor, 1);
  }
  return expected;
}

function classToSlotKey(
  startsAt: Date,
  timezone: string,
  templateName: string,
): string {
  const dateKey = getStudioLocalDateKey(startsAt, timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(startsAt);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return slotKey(dateKey, `${hh}:${mm}`, templateName);
}

async function main(): Promise<void> {
  const now = new Date();
  console.log('════════════════════════════════════════════════════════════');
  console.log('  ARES 1.3 — REAL SCHEDULE MIGRATION');
  console.log(`  Mode   : ${DRY_RUN ? 'DRY_RUN' : 'LIVE_RUN'}`);
  console.log(`  Studio : ${ARES_SLUG}`);
  console.log(`  Run at : ${now.toISOString()}`);
  console.log('════════════════════════════════════════════════════════════');

  const studio = await prisma.studio.findUnique({
    where: { slug: ARES_SLUG },
    select: { id: true, name: true, timezone: true },
  });
  if (!studio) {
    console.error(`Studio "${ARES_SLUG}" not found. Aborting.`);
    process.exit(1);
  }
  const timezone = studio.timezone || ARES_TZ;
  const todayKey = getStudioLocalDateKey(now, timezone);

  // ── Current state ────────────────────────────────────────────────────────
  section('CURRENT STATE');
  const futureScheduled = await prisma.scheduledClass.count({
    where: {
      studioId: studio.id,
      status: ClassStatus.SCHEDULED,
      startsAt: { gt: now },
    },
  });
  const activeTemplates = await prisma.scheduleTemplate.count({
    where: { studioId: studio.id, active: true, deletedAt: null },
  });
  const automation = await prisma.scheduleAutomationSettings.findUnique({
    where: { studioId: studio.id },
  });
  console.log(`  Future SCHEDULED classes     : ${futureScheduled}`);
  console.log(`  Active schedule templates    : ${activeTemplates}`);
  console.log(
    `  Automation                   : enabled=${automation?.enabled ?? false}, minFutureDays=${automation?.minFutureDays ?? 90}`,
  );
  console.log(`  Weekly pattern slots         : ${totalWeeklyTemplateSlots()} (Mon–Sun)`);
  console.log(`  Expected per week            : ${JSON.stringify(expectedClassesPerWeek())}`);

  // ── 1. Class templates ───────────────────────────────────────────────────
  section('CLASS TEMPLATES — rename + create');
  const templateMap = await resolveTemplateMap(studio.id);
  const renameResults: Record<string, string> = {};
  for (const { from, to } of ARES_TEMPLATE_RENAMES) {
    renameResults[`${from}→${to}`] = await renameTemplateIfSafe(studio.id, from, to, templateMap);
  }
  const createResults: Record<string, string> = {};
  for (const def of ARES_NEW_TEMPLATES) {
    createResults[def.name] = await createTemplateIfMissing(studio.id, def, templateMap);
  }

  // Refresh map after writes (dry-run uses simulated map)
  const resolvedMap = DRY_RUN ? templateMap : await resolveTemplateMap(studio.id);

  // ── 2. Open Gym copy ─────────────────────────────────────────────────────
  section('OPEN GYM COPY — membership plans');
  const plansUpdated = await updateOpenGymPlanCopy(studio.id);
  console.log(`  Plans with Open Gym copy updated: ${plansUpdated}`);

  // ── 3. Schedule templates ──────────────────────────────────────────────
  section('SCHEDULE TEMPLATES — soft-delete active + insert pattern');
  const existingActive = await prisma.scheduleTemplate.findMany({
    where: { studioId: studio.id, deletedAt: null, active: true },
    include: { classTemplate: { select: { name: true } } },
  });
  console.log(`  Active templates to retire: ${existingActive.length}`);
  for (const st of existingActive) {
    log('SOFT_DEL', 'ScheduleTemplate', `${st.classTemplate.name} dow=${st.dayOfWeek} ${st.startTime}`);
    if (!DRY_RUN) {
      await prisma.scheduleTemplate.update({
        where: { id: st.id },
        data: { active: false, deletedAt: now },
      });
    }
  }

  const toInsert: Array<{ dayOfWeek: number; startTime: string; classTemplateName: string }> = [];
  for (const day of ARES_WEEKLY_SCHEDULE) {
    for (const startTime of day.startTimes) {
      toInsert.push({
        dayOfWeek: day.dayOfWeek,
        startTime: padTime(startTime),
        classTemplateName: day.classTemplateName,
      });
    }
  }

  console.log(`  New schedule template rows   : ${toInsert.length}`);
  for (const row of toInsert) {
    const templateId = resolvedMap.get(row.classTemplateName);
    if (!templateId) {
      console.log(`  !! MISSING template "${row.classTemplateName}" — cannot insert slot dow=${row.dayOfWeek} ${row.startTime}`);
      continue;
    }
    log(
      'CREATE',
      'ScheduleTemplate',
      `${row.classTemplateName} dow=${row.dayOfWeek} ${row.startTime}`,
    );
    if (!DRY_RUN) {
      await prisma.scheduleTemplate.create({
        data: {
          studioId: studio.id,
          classTemplateId: templateId,
          dayOfWeek: row.dayOfWeek,
          startTime: row.startTime,
          active: true,
        },
      });
    }
  }

  // ── 4. Future class analysis ─────────────────────────────────────────────
  section('FUTURE CLASS ANALYSIS');
  const expected = buildExpectedSlots(resolvedMap, todayKey, ARES_GENERATE_THROUGH);

  const futureClasses = await prisma.scheduledClass.findMany({
    where: {
      studioId: studio.id,
      status: ClassStatus.SCHEDULED,
      startsAt: { gt: now },
    },
    include: {
      classTemplate: { select: { name: true } },
      bookings: {
        where: { status: { in: [BookingStatus.CONFIRMED, BookingStatus.PENDING] } },
        select: { id: true, status: true, userId: true },
      },
    },
    orderBy: { startsAt: 'asc' },
  });

  const toCancel: typeof futureClasses = [];
  const matching: typeof futureClasses = [];
  for (const sc of futureClasses) {
    const key = classToSlotKey(sc.startsAt, timezone, sc.classTemplate.name);
    if (expected.has(key)) {
      matching.push(sc);
    } else {
      toCancel.push(sc);
    }
  }

  const bookingsAffected = toCancel.reduce((n, sc) => n + sc.bookings.length, 0);
  const classesWithBookings = toCancel.filter((sc) => sc.bookings.length > 0);

  console.log(`  Future SCHEDULED (total)     : ${futureClasses.length}`);
  console.log(`  Match new pattern (keep)     : ${matching.length}`);
  console.log(`  Obsolete (to cancel)         : ${toCancel.length}`);
  console.log(`  Bookings on obsolete classes : ${bookingsAffected}`);
  console.log(`  Obsolete classes w/ bookings : ${classesWithBookings.length}`);

  if (classesWithBookings.length > 0) {
    console.log('\n  Classes with bookings (require approval to cancel):');
    for (const sc of classesWithBookings.slice(0, 20)) {
      console.log(
        `    ${sc.startsAt.toISOString()} ${sc.classTemplate.name} — ${sc.bookings.length} booking(s)`,
      );
    }
    if (classesWithBookings.length > 20) {
      console.log(`    … and ${classesWithBookings.length - 20} more`);
    }
  }

  // Classes to generate (dry-run generator logic)
  const utcThrough = studioLocalTimeToUtc(ARES_GENERATE_THROUGH, '23:59', timezone);
  const existingKeys = new Set(
    futureClasses.map((sc) => `${sc.classTemplateId}|${sc.startsAt.toISOString()}`),
  );
  matching.forEach((sc) =>
    existingKeys.add(`${sc.classTemplateId}|${sc.startsAt.toISOString()}`),
  );

  let toGenerate = 0;
  const generateBreakdown: Record<string, number> = {};
  let cursor = todayKey;
  while (cursor <= ARES_GENERATE_THROUGH) {
    const dow = getDayOfWeekFromDateKey(cursor);
    for (const day of ARES_WEEKLY_SCHEDULE) {
      if (day.dayOfWeek !== dow) continue;
      const templateId = resolvedMap.get(day.classTemplateName);
      if (!templateId) continue;
      for (const t of day.startTimes) {
        const startsAt = studioLocalTimeToUtc(cursor, padTime(t), timezone);
        if (startsAt <= now) continue;
        const key = `${templateId}|${startsAt.toISOString()}`;
        if (!existingKeys.has(key)) {
          toGenerate++;
          generateBreakdown[day.classTemplateName] =
            (generateBreakdown[day.classTemplateName] ?? 0) + 1;
          existingKeys.add(key);
        }
      }
    }
    cursor = addDaysToDateKey(cursor, 1);
  }

  console.log(`  Classes to generate → ${ARES_GENERATE_THROUGH}: ${toGenerate}`);
  console.log(`  Generate breakdown           : ${JSON.stringify(generateBreakdown)}`);

  const finalCoverageDate = ARES_GENERATE_THROUGH;
  console.log(`  Final coverage target        : ${finalCoverageDate}`);

  // Spot-check pattern counts (static — independent of calendar window)
  section('SPOT CHECK — weekly pattern');
  const spotCounts = expectedClassesPerWeek();
  console.log(`  Pattern counts per day: ${JSON.stringify(spotCounts)}`);
  console.log('  Expected: Mon–Thu=7, Fri=5, Sat=2, Sun=1');

  // ── 5. LIVE execution gates ──────────────────────────────────────────────
  if (!DRY_RUN) {
    section('LIVE EXECUTION');
    if (classesWithBookings.length > 0 && !APPROVE_BOOKINGS) {
      console.error(
        '\n  ABORT: Obsolete classes have active bookings. Set APPROVE_CANCEL_WITH_BOOKINGS=true to proceed.',
      );
      process.exit(2);
    }

    const cancelIds = toCancel.map((sc) => sc.id);
    if (cancelIds.length > 0) {
      log('UPDATE', 'ScheduledClass', `cancel ${cancelIds.length} obsolete future class(es)`);
      await prisma.scheduledClass.updateMany({
        where: { id: { in: cancelIds } },
        data: { status: ClassStatus.CANCELLED, cancelReason: ARES_MIGRATION_CANCEL_REASON },
      });
    }

    // Generate missing classes through end of year
    const createRows: Array<{
      studioId: string;
      classTemplateId: string;
      startsAt: Date;
      endsAt: Date;
      capacity: number;
      status: ClassStatus;
    }> = [];

    cursor = todayKey;
    while (cursor <= ARES_GENERATE_THROUGH) {
      const dow = getDayOfWeekFromDateKey(cursor);
      for (const day of ARES_WEEKLY_SCHEDULE) {
        if (day.dayOfWeek !== dow) continue;
        const templateId = resolvedMap.get(day.classTemplateName);
        if (!templateId) continue;
        const tpl = await prisma.classTemplate.findUnique({
          where: { id: templateId },
          select: { durationMinutes: true, defaultCapacity: true },
        });
        if (!tpl) continue;
        for (const t of day.startTimes) {
          const startsAt = studioLocalTimeToUtc(cursor, padTime(t), timezone);
          if (startsAt <= now) continue;
          const exists = await prisma.scheduledClass.findFirst({
            where: {
              studioId: studio.id,
              classTemplateId: templateId,
              startsAt,
              status: ClassStatus.SCHEDULED,
            },
            select: { id: true },
          });
          if (exists) continue;
          createRows.push({
            studioId: studio.id,
            classTemplateId: templateId,
            startsAt,
            endsAt: new Date(startsAt.getTime() + tpl.durationMinutes * 60_000),
            capacity: tpl.defaultCapacity,
            status: ClassStatus.SCHEDULED,
          });
        }
      }
      cursor = addDaysToDateKey(cursor, 1);
    }

    if (createRows.length > 0) {
      log('CREATE', 'ScheduledClass', `bulk insert ${createRows.length} class(es)`);
      await prisma.scheduledClass.createMany({ data: createRows });
    }

    log('UPSERT', 'ScheduleAutomation', 'enabled=true, minFutureDays=90');
    await prisma.scheduleAutomationSettings.upsert({
      where: { studioId: studio.id },
      create: { studioId: studio.id, enabled: true, minFutureDays: 90 },
      update: { enabled: true, minFutureDays: 90 },
    });
  }

  // ── JSON summary ─────────────────────────────────────────────────────────
  section('JSON SUMMARY');
  const summary = {
    event: 'ares_1_3_schedule_migration',
    studio: ARES_SLUG,
    studioId: studio.id,
    dryRun: DRY_RUN,
    runAt: now.toISOString(),
    current: {
      futureScheduledClassCount: futureScheduled,
      activeScheduleTemplateCount: activeTemplates,
      automation: automation ?? { enabled: false, minFutureDays: 90 },
    },
    templateRenames: renameResults,
    templatesCreated: createResults,
    adhocTemplatesPreserved: ARES_ADHOC_TEMPLATE_NAMES,
    scheduleTemplatesRetired: existingActive.length,
    scheduleTemplatesInserted: toInsert.length,
    openGymPlansUpdated: plansUpdated,
    futureAnalysis: {
      futureScheduledTotal: futureClasses.length,
      matchingPattern: matching.length,
      toCancel: toCancel.length,
      bookingsAffected,
      obsoleteClassesWithBookings: classesWithBookings.length,
      toGenerate,
      generateBreakdown,
      coverageThrough: ARES_GENERATE_THROUGH,
    },
    spotCheck: spotCounts,
    risks:
      classesWithBookings.length > 0
        ? ['BOOKINGS_ON_OBSOLETE_CLASSES']
        : [],
    approvalNeeded:
      DRY_RUN || classesWithBookings.length === 0
        ? []
        : ['APPROVE_CANCEL_WITH_BOOKINGS=true'],
  };
  console.log(JSON.stringify(summary, null, 2));

  if (DRY_RUN) {
    console.log('\n  DRY_RUN complete — no data modified.');
    console.log('  To execute: LIVE_RUN=true pnpm --filter api migrate:ares-1.3-schedule');
    if (classesWithBookings.length > 0) {
      console.log('  Also set APPROVE_CANCEL_WITH_BOOKINGS=true if you accept cancelling booked classes.');
    }
  }
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
