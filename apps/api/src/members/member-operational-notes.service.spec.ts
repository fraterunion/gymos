import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemberOperationalNotesService } from './member-operational-notes.service';

describe('MemberOperationalNotesService', () => {
  const prisma = {
    studioMembership: { findFirst: jest.fn() },
    memberOperationalNote: { findMany: jest.fn(), create: jest.fn() },
  };

  const service = new MemberOperationalNotesService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists notes scoped to studio and member', async () => {
    prisma.studioMembership.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.memberOperationalNote.findMany.mockResolvedValue([{ id: 'n1' }]);

    const rows = await service.listNotes('studio-1', 'user-1', 10);

    expect(rows).toHaveLength(1);
    expect(prisma.memberOperationalNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studioId: 'studio-1', memberUserId: 'user-1' },
        take: 10,
      }),
    );
  });

  it('rejects empty note body', async () => {
    prisma.studioMembership.findFirst.mockResolvedValue({ id: 'm1' });

    await expect(
      service.createNote('studio-1', 'user-1', 'author-1', { body: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws when member not found', async () => {
    prisma.studioMembership.findFirst.mockResolvedValue(null);

    await expect(service.listNotes('studio-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates note with trimmed body and author', async () => {
    prisma.studioMembership.findFirst.mockResolvedValue({ id: 'm1' });
    prisma.memberOperationalNote.create.mockResolvedValue({ id: 'n1', body: 'Hola' });

    const note = await service.createNote('studio-1', 'user-1', 'author-1', {
      body: '  Hola  ',
    });

    expect(note.body).toBe('Hola');
    expect(prisma.memberOperationalNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          studioId: 'studio-1',
          memberUserId: 'user-1',
          authorUserId: 'author-1',
          body: 'Hola',
        }),
      }),
    );
  });
});
