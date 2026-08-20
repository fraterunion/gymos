import { BadRequestException } from '@nestjs/common';
import { ClassTemplatesService } from './class-templates.service';

describe('ClassTemplatesService — Open Gym access window', () => {
  const prisma = {
    classTemplate: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    membershipPlan: { findMany: jest.fn() },
    dayPassClassAccess: { findMany: jest.fn() },
    studioMembership: { findFirst: jest.fn() },
  };

  const service = new ClassTemplatesService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates an Open Gym template with a valid window', async () => {
    prisma.classTemplate.create.mockResolvedValue({ id: 't1' });

    await service.createTemplate('studio-1', {
      name: 'Open Gym',
      durationMinutes: 60,
      isOpenGymSlot: true,
      accessWindowStart: '10:00',
      accessWindowEnd: '17:00',
    } as never);

    expect(prisma.classTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isOpenGymSlot: true,
          accessWindowStart: '10:00',
          accessWindowEnd: '17:00',
        }),
      }),
    );
  });

  it('rejects a window with only a start time set', async () => {
    await expect(
      service.createTemplate('studio-1', {
        name: 'Open Gym',
        durationMinutes: 60,
        accessWindowStart: '10:00',
      } as never),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.classTemplate.create).not.toHaveBeenCalled();
  });

  it('rejects a window where start is not before end', async () => {
    await expect(
      service.createTemplate('studio-1', {
        name: 'Open Gym',
        durationMinutes: 60,
        accessWindowStart: '17:00',
        accessWindowEnd: '10:00',
      } as never),
    ).rejects.toThrow(/earlier than/i);
  });

  it('allows a template with no window at all (regular class)', async () => {
    prisma.classTemplate.create.mockResolvedValue({ id: 't1' });
    await service.createTemplate('studio-1', {
      name: 'Calirox',
      durationMinutes: 60,
    } as never);
    expect(prisma.classTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accessWindowStart: null, accessWindowEnd: null }),
      }),
    );
  });

  it('update merges a partial window change against the existing value and rejects if invalid', async () => {
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 't1',
      studioId: 'studio-1',
      accessWindowStart: '10:00',
      accessWindowEnd: '17:00',
    });

    // Moving only the start past the existing end must be rejected, not silently accepted.
    await expect(
      service.updateTemplate('studio-1', 't1', { accessWindowStart: '18:00' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.classTemplate.update).not.toHaveBeenCalled();
  });

  it('update allows clearing both bounds together', async () => {
    prisma.classTemplate.findFirst.mockResolvedValue({
      id: 't1',
      studioId: 'studio-1',
      accessWindowStart: '10:00',
      accessWindowEnd: '17:00',
    });
    prisma.classTemplate.update.mockResolvedValue({ id: 't1' });

    await service.updateTemplate('studio-1', 't1', {
      accessWindowStart: null,
      accessWindowEnd: null,
    } as never);

    expect(prisma.classTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accessWindowStart: null, accessWindowEnd: null }),
      }),
    );
  });
});

describe('ClassTemplatesService.listAccessSummary', () => {
  const prisma = {
    classTemplate: { findMany: jest.fn() },
    membershipPlan: { findMany: jest.fn() },
    dayPassClassAccess: { findMany: jest.fn() },
  };

  const service = new ClassTemplatesService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flags a class with zero plan access and no Day Pass access as orphan', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 't1', name: 'New Class', category: null, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
    ]);
    prisma.membershipPlan.findMany.mockResolvedValue([
      { id: 'p1', name: 'Basic', allClassesAccess: false, allowedCategories: [], classTemplateAccess: [] },
    ]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([]);

    const [result] = await service.listAccessSummary('studio-1');

    expect(result.planCount).toBe(0);
    expect(result.dayPassAllowed).toBe(false);
    expect(result.orphan).toBe(true);
  });

  it('a class with one allowing plan is not orphaned', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 't1', name: 'Calirox', category: null, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
    ]);
    prisma.membershipPlan.findMany.mockResolvedValue([
      { id: 'p1', name: 'Basic', allClassesAccess: false, allowedCategories: [], classTemplateAccess: [{ classTemplateId: 't1' }] },
    ]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([]);

    const [result] = await service.listAccessSummary('studio-1');

    expect(result.planCount).toBe(1);
    expect(result.planNames).toEqual(['Basic']);
    expect(result.orphan).toBe(false);
  });

  it('Day Pass access alone counts as a valid access path (not orphaned)', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 't1', name: 'Calirox', category: null, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
    ]);
    prisma.membershipPlan.findMany.mockResolvedValue([]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([{ classTemplateId: 't1' }]);

    const [result] = await service.listAccessSummary('studio-1');

    expect(result.planCount).toBe(0);
    expect(result.dayPassAllowed).toBe(true);
    expect(result.orphan).toBe(false);
  });

  it('an allClassesAccess plan is counted against every template, restricted plans are isolated per template', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 'booty', name: 'Booty Lab', category: null, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
      { id: 'calirox', name: 'Calirox', category: null, isOpenGymSlot: false, accessWindowStart: null, accessWindowEnd: null },
    ]);
    prisma.membershipPlan.findMany.mockResolvedValue([
      { id: 'full', name: 'Full Access', allClassesAccess: true, allowedCategories: [], classTemplateAccess: [] },
      { id: 'booty-plan', name: 'Booty Lab by Etzia', allClassesAccess: false, allowedCategories: [], classTemplateAccess: [{ classTemplateId: 'booty' }] },
    ]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([]);

    const results = await service.listAccessSummary('studio-1');
    const booty = results.find((r) => r.id === 'booty')!;
    const calirox = results.find((r) => r.id === 'calirox')!;

    // Booty Lab: only the Booty Lab plan (explicit) + Full Access (allClassesAccess) — never an unrelated restricted plan.
    expect(booty.planNames.sort()).toEqual(['Booty Lab by Etzia', 'Full Access']);
    // Calirox: only Full Access grants it — the Booty Lab plan must not leak access to unrelated classes.
    expect(calirox.planNames).toEqual(['Full Access']);
  });

  it('identifies the Open Gym template and its window in the summary', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 'og', name: 'Open Gym', category: null, isOpenGymSlot: true, accessWindowStart: '10:00', accessWindowEnd: '17:00' },
    ]);
    prisma.membershipPlan.findMany.mockResolvedValue([
      { id: 'og-plan', name: 'Open Gym', allClassesAccess: false, allowedCategories: [], classTemplateAccess: [{ classTemplateId: 'og' }] },
    ]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([]);

    const [result] = await service.listAccessSummary('studio-1');

    expect(result.isOpenGymSlot).toBe(true);
    expect(result.accessWindowStart).toBe('10:00');
    expect(result.accessWindowEnd).toBe('17:00');
    expect(result.orphan).toBe(false);
  });
});
