import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Role, WaiverAcceptanceMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WaiverService } from './waiver.service';

describe('WaiverService', () => {
  let service: WaiverService;
  let prisma: {
    studio: { findFirst: jest.Mock };
    studioWaiverDocument: { findFirst: jest.Mock; findUnique: jest.Mock };
    waiverAcceptance: { findUnique: jest.Mock; create: jest.Mock };
    studioMembership: { findFirst: jest.Mock };
  };

  const activeDoc = {
    id: 'doc-1',
    studioId: 'studio-1',
    version: '2026-07-01-v1',
    title: 'Carta Responsiva',
    bodyMarkdown: 'text',
    effectiveAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    prisma = {
      studio: { findFirst: jest.fn() },
      studioWaiverDocument: { findFirst: jest.fn(), findUnique: jest.fn() },
      waiverAcceptance: { findUnique: jest.fn(), create: jest.fn() },
      studioMembership: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [WaiverService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(WaiverService);
    prisma.studioWaiverDocument.findFirst.mockResolvedValue(activeDoc);
  });

  it('requires waiver acceptance on register when active waiver exists', async () => {
    await expect(
      service.validateRegistrationWaiver({ studioId: 'studio-1' }),
    ).rejects.toThrow(new BadRequestException('Debes aceptar la Carta Responsiva para crear tu cuenta.'));
  });

  it('blocks member commercial actions without acceptance', async () => {
    prisma.studioMembership.findFirst.mockResolvedValue({ role: Role.MEMBER });
    prisma.waiverAcceptance.findUnique.mockResolvedValue(null);

    await expect(service.assertMemberWaiverAccepted('studio-1', 'user-1')).rejects.toThrow(
      new ForbiddenException('Debes aceptar la Carta Responsiva antes de continuar.'),
    );
  });

  it('creates self acceptance with metadata', async () => {
    prisma.studioWaiverDocument.findFirst.mockResolvedValue({ ...activeDoc, isActive: true });
    prisma.waiverAcceptance.findUnique.mockResolvedValue(null);
    prisma.waiverAcceptance.create.mockResolvedValue({
      id: 'acc-1',
      method: WaiverAcceptanceMethod.SELF,
    });

    await service.createSelfAcceptance({
      studioId: 'studio-1',
      userId: 'user-1',
      waiverDocumentId: 'doc-1',
      ipAddress: '127.0.0.1',
      userAgent: 'jest',
    });

    expect(prisma.waiverAcceptance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          method: WaiverAcceptanceMethod.SELF,
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
        }),
      }),
    );
  });
});
