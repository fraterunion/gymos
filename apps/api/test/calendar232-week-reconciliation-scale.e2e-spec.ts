import type { INestApplication } from '@nestjs/common';
import { ClassStatus, Role } from '@prisma/client';
import { ScheduleOperationsService } from '../src/schedule/schedule-operations.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/create-app';
import { truncateAll } from './helpers/db';
import {
  createClassTemplate,
  createMembership,
  createScheduledClass,
  createStudio,
  createUserWithPassword,
} from './helpers/factories';
import {
  addDaysToDateKey,
  studioLocalTimeToUtc,
} from '../src/common/date/studio-local-date';
import { WEEK_RECONCILIATION_AUDIT_ID_CAP } from '../src/schedule/schedule-week-reconciliation-apply';

describe('Calendar 2.3.2 duplicate-week scale (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ops: ScheduleOperationsService;

  const TZ = 'America/Mexico_City';
  const SOURCE_WEEK = '2026-08-17';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    ops = app.get(ScheduleOperationsService);
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function seedAdmin(studioId: string) {
    const admin = await createUserWithPassword(prisma, {
      email: `admin-scale-${Date.now()}-${Math.random()}@e2e.local`,
      password: 'password12',
    });
    await createMembership(prisma, admin.id, studioId, Role.ADMIN);
    return admin;
  }

  async function seedProductionShapedWorkload(
    studioId: string,
    sourceWeekStart: string,
    targetWeekStarts: string[],
    options: {
      sourceClassCount: number;
      reusePerTargetWeek: number;
      extrasPerTargetWeek: number;
    },
  ) {
    const templates = await Promise.all(
      Array.from({ length: options.sourceClassCount }, (_, i) =>
        createClassTemplate(prisma, studioId, { name: `Class ${i + 1}` }),
      ),
    );

    const sourceSlots: Array<{ templateIndex: number; dayOffset: number; hour: string }> = [];
    for (let i = 0; i < templates.length; i++) {
      const dayOffset = i % 7;
      const hour = String(6 + (i % 14)).padStart(2, '0');
      const day = addDaysToDateKey(sourceWeekStart, dayOffset);
      sourceSlots.push({ templateIndex: i, dayOffset, hour });
      await createScheduledClass(prisma, studioId, templates[i]!.id, {
        startsAt: studioLocalTimeToUtc(day, `${hour}:00`, TZ),
        endsAt: studioLocalTimeToUtc(day, `${String(Number(hour) + 1).padStart(2, '0')}:00`, TZ),
        capacity: 12,
      });
    }

    for (const targetWeekStart of targetWeekStarts) {
      for (let i = 0; i < options.reusePerTargetWeek; i++) {
        const slot = sourceSlots[i]!;
        const day = addDaysToDateKey(targetWeekStart, slot.dayOffset);
        await createScheduledClass(prisma, studioId, templates[slot.templateIndex]!.id, {
          startsAt: studioLocalTimeToUtc(day, `${slot.hour}:00`, TZ),
          endsAt: studioLocalTimeToUtc(
            day,
            `${String(Number(slot.hour) + 1).padStart(2, '0')}:00`,
            TZ,
          ),
          capacity: 12,
        });
      }

      for (let j = 0; j < options.extrasPerTargetWeek; j++) {
        const tpl = templates[(options.reusePerTargetWeek + j) % templates.length]!;
        const day = addDaysToDateKey(targetWeekStart, (j + 3) % 7);
        const hour = String(19 + (j % 3)).padStart(2, '0');
        await createScheduledClass(prisma, studioId, tpl.id, {
          startsAt: studioLocalTimeToUtc(day, `${hour}:15`, TZ),
          endsAt: studioLocalTimeToUtc(day, `${hour}:55`, TZ),
          capacity: 8,
        });
      }
    }

    const expectedCreates =
      (options.sourceClassCount - options.reusePerTargetWeek) * targetWeekStarts.length;
    const expectedReuse = options.reusePerTargetWeek * targetWeekStarts.length;
    const expectedRemoves = options.extrasPerTargetWeek * targetWeekStarts.length;

    return { expectedCreates, expectedReuse, expectedRemoves, templates };
  }

  async function assertNoDuplicateCanonicalKeys(studioId: string) {
    const dup = await prisma.$queryRaw<Array<{ cnt: bigint }>>`
      SELECT COUNT(*)::bigint AS cnt FROM (
        SELECT 1 FROM scheduled_classes
        WHERE studio_id = ${studioId}
        GROUP BY class_template_id, starts_at
        HAVING COUNT(*) > 1
      ) d
    `;
    expect(Number(dup[0]?.cnt ?? 0)).toBe(0);
  }

  it('executes production-shaped 12-week reconciliation within bounded time', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const targetWeekStarts = Array.from({ length: 12 }, (_, i) =>
      addDaysToDateKey(SOURCE_WEEK, 7 * (i + 1)),
    );
    const { expectedCreates, expectedReuse, expectedRemoves } =
      await seedProductionShapedWorkload(studio.id, SOURCE_WEEK, targetWeekStarts, {
        sourceClassCount: 34,
        reusePerTargetWeek: 5,
        extrasPerTargetWeek: 10,
      });
    const admin = await seedAdmin(studio.id);

    const preview = await ops.previewDuplicateWeek(studio.id, {
      sourceWeekStart: SOURCE_WEEK,
      targetWeekStarts,
    });
    expect(preview.createdCount).toBe(expectedCreates);
    expect(preview.reusedCount).toBe(expectedReuse);
    expect(preview.removedCount).toBe(expectedRemoves);

    const beforeCount = await prisma.scheduledClass.count({ where: { studioId: studio.id } });
    const started = Date.now();
    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts,
        confirmWarnings: true,
        confirmRemovals: true,
        idempotencyKey: `scale-12-${Date.now()}`,
      },
      admin.id,
    );
    const elapsedMs = Date.now() - started;

    expect(result.createdCount).toBe(expectedCreates);
    expect(result.reusedCount).toBe(expectedReuse);
    expect(result.removedCount).toBe(expectedRemoves);
    expect(elapsedMs).toBeLessThan(30_000);

    const afterCount = await prisma.scheduledClass.count({ where: { studioId: studio.id } });
    expect(afterCount - beforeCount).toBe(expectedCreates);
    const removedRows = await prisma.scheduledClass.count({
      where: {
        studioId: studio.id,
        status: ClassStatus.CANCELLED,
        cancelReason: 'Removed by week reconciliation',
      },
    });
    expect(removedRows).toBe(expectedRemoves);
    await assertNoDuplicateCanonicalKeys(studio.id);
  }, 120_000);

  it('executes 26-week reconciliation within bounded time', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const targetWeekStarts = Array.from({ length: 26 }, (_, i) =>
      addDaysToDateKey(SOURCE_WEEK, 7 * (i + 1)),
    );
    await seedProductionShapedWorkload(studio.id, SOURCE_WEEK, targetWeekStarts, {
      sourceClassCount: 20,
      reusePerTargetWeek: 4,
      extrasPerTargetWeek: 6,
    });
    const admin = await seedAdmin(studio.id);

    const started = Date.now();
    const result = await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts,
        confirmWarnings: true,
        confirmRemovals: true,
      },
      admin.id,
    );
    const elapsedMs = Date.now() - started;

    expect(result.createdCount).toBeGreaterThan(200);
    expect(result.removedCount).toBeGreaterThan(100);
    expect(elapsedMs).toBeLessThan(45_000);
    await assertNoDuplicateCanonicalKeys(studio.id);
  }, 180_000);

  it('stores bounded audit metadata for large reconciliation', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const targetWeekStarts = Array.from({ length: 12 }, (_, i) =>
      addDaysToDateKey(SOURCE_WEEK, 7 * (i + 1)),
    );
    await seedProductionShapedWorkload(studio.id, SOURCE_WEEK, targetWeekStarts, {
      sourceClassCount: 34,
      reusePerTargetWeek: 5,
      extrasPerTargetWeek: 10,
    });
    const admin = await seedAdmin(studio.id);
    const idempotencyKey = `audit-bound-${Date.now()}`;

    await ops.executeDuplicateWeek(
      studio.id,
      {
        sourceWeekStart: SOURCE_WEEK,
        targetWeekStarts,
        confirmWarnings: true,
        confirmRemovals: true,
        idempotencyKey,
      },
      admin.id,
    );

    const audit = await prisma.auditLog.findFirst({
      where: { studioId: studio.id, action: 'SCHEDULE_WEEK_DUPLICATED' },
      orderBy: { createdAt: 'desc' },
    });
    const meta = audit?.metadata as Record<string, unknown> | null;
    expect(meta?.idempotencyKey).toBe(idempotencyKey);
    expect(Array.isArray(meta?.affectedClassIds)).toBe(true);
    expect((meta?.affectedClassIds as unknown[]).length).toBeLessThanOrEqual(
      WEEK_RECONCILIATION_AUDIT_ID_CAP,
    );
    expect(meta?.affectedClassIdsTruncated).toBe(true);
    expect(meta?.result).toBeTruthy();
    expect((meta?.result as Record<string, unknown>)?.reconciliationItems).toBeUndefined();
  }, 120_000);

  it('rolls back fully when execute is blocked by review items', async () => {
    const studio = await createStudio(prisma, { timezone: TZ });
    const tpl = await createClassTemplate(prisma, studio.id);
    await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-08-18', '07:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-18', '08:00', TZ),
    });
    const extra = await createScheduledClass(prisma, studio.id, tpl.id, {
      startsAt: studioLocalTimeToUtc('2026-08-25', '18:00', TZ),
      endsAt: studioLocalTimeToUtc('2026-08-25', '19:00', TZ),
    });
    const member = await createUserWithPassword(prisma);
    await createMembership(prisma, member.id, studio.id, Role.STAFF);
    await prisma.booking.create({
      data: {
        studioId: studio.id,
        scheduledClassId: extra.id,
        userId: member.id,
        status: 'CONFIRMED',
      },
    });
    const admin = await seedAdmin(studio.id);
    const beforeCount = await prisma.scheduledClass.count({ where: { studioId: studio.id } });

    await expect(
      ops.executeDuplicateWeek(
        studio.id,
        {
          sourceWeekStart: SOURCE_WEEK,
          targetWeekStarts: ['2026-08-24'],
          confirmWarnings: true,
          confirmRemovals: true,
        },
        admin.id,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        reviewCount: expect.any(Number),
      }),
    });

    const afterCount = await prisma.scheduledClass.count({ where: { studioId: studio.id } });
    expect(afterCount).toBe(beforeCount);
    const extraRow = await prisma.scheduledClass.findUnique({ where: { id: extra.id } });
    expect(extraRow?.status).toBe(ClassStatus.SCHEDULED);
  });
});
