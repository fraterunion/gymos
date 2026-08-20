import { BadRequestException } from '@nestjs/common';
import { DayPassClassAccessService } from './day-pass-class-access.service';

describe('DayPassClassAccessService', () => {
  const prisma = {
    classTemplate: { findMany: jest.fn(), findFirst: jest.fn() },
    dayPassClassAccess: { findMany: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  };

  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new DayPassClassAccessService(prisma as never, audit as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks templates allowed based on the studio allowlist', async () => {
    prisma.classTemplate.findMany.mockResolvedValue([
      { id: 't1', name: 'Calirox', durationMinutes: 60, isOpenGymSlot: false },
      { id: 't2', name: 'Booty Lab', durationMinutes: 45, isOpenGymSlot: false },
      { id: 't3', name: 'Open Gym', durationMinutes: 60, isOpenGymSlot: true },
    ]);
    prisma.dayPassClassAccess.findMany.mockResolvedValue([{ classTemplateId: 't1' }]);

    const result = await service.listAccess('studio-1');

    expect(result).toEqual([
      { id: 't1', name: 'Calirox', durationMinutes: 60, isOpenGymSlot: false, active: true, allowed: true },
      { id: 't2', name: 'Booty Lab', durationMinutes: 45, isOpenGymSlot: false, active: true, allowed: false },
      { id: 't3', name: 'Open Gym', durationMinutes: 60, isOpenGymSlot: true, active: true, allowed: false },
    ]);
  });

  it('rejects granting access to a template outside the studio', async () => {
    prisma.classTemplate.findFirst.mockResolvedValue(null);

    await expect(service.grantAccess('studio-1', 'foreign-template')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.dayPassClassAccess.upsert).not.toHaveBeenCalled();
  });

  it('grants access idempotently via upsert', async () => {
    prisma.classTemplate.findFirst.mockResolvedValue({ id: 't1' });

    await service.grantAccess('studio-1', 't1');

    expect(prisma.dayPassClassAccess.upsert).toHaveBeenCalledWith({
      where: { studioId_classTemplateId: { studioId: 'studio-1', classTemplateId: 't1' } },
      create: { studioId: 'studio-1', classTemplateId: 't1' },
      update: {},
    });
  });

  it('revokes access without throwing when no row exists', async () => {
    await service.revokeAccess('studio-1', 'never-granted');

    expect(prisma.dayPassClassAccess.deleteMany).toHaveBeenCalledWith({
      where: { studioId: 'studio-1', classTemplateId: 'never-granted' },
    });
  });
});
