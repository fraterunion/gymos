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
    isActive: true,
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

  // ─── validateRegistrationWaiver ──────────────────────────────────────────
  describe('validateRegistrationWaiver', () => {
    it('requires waiver acceptance when active waiver exists', async () => {
      await expect(
        service.validateRegistrationWaiver({ studioId: 'studio-1' }),
      ).rejects.toThrow(new BadRequestException('Debes aceptar la Carta Responsiva para crear tu cuenta.'));
    });

    it('returns null when no active waiver exists', async () => {
      prisma.studioWaiverDocument.findFirst.mockResolvedValue(null);
      const result = await service.validateRegistrationWaiver({ studioId: 'studio-1' });
      expect(result).toBeNull();
    });

    it('throws when waiverDocumentId does not match active document', async () => {
      await expect(
        service.validateRegistrationWaiver({
          studioId: 'studio-1',
          waiverDocumentId: 'doc-WRONG',
          waiverAccepted: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns waiverDocumentId when document matches and accepted', async () => {
      const result = await service.validateRegistrationWaiver({
        studioId: 'studio-1',
        waiverDocumentId: 'doc-1',
        waiverAccepted: true,
      });
      expect(result).toEqual({ waiverDocumentId: 'doc-1' });
    });
  });

  // ─── assertMemberWaiverAccepted ──────────────────────────────────────────
  describe('assertMemberWaiverAccepted', () => {
    it('blocks member commercial actions without acceptance', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue({ role: Role.MEMBER });
      prisma.waiverAcceptance.findUnique.mockResolvedValue(null);

      await expect(service.assertMemberWaiverAccepted('studio-1', 'user-1')).rejects.toThrow(
        new ForbiddenException('Debes aceptar la Carta Responsiva antes de continuar.'),
      );
    });

    it('allows member with valid acceptance to proceed', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue({ role: Role.MEMBER });
      prisma.waiverAcceptance.findUnique.mockResolvedValue({ id: 'acc-1' });

      await expect(service.assertMemberWaiverAccepted('studio-1', 'user-1')).resolves.not.toThrow();
    });

    it('allows non-member roles without checking waiver', async () => {
      prisma.studioMembership.findFirst.mockResolvedValue({ role: Role.STAFF });

      await expect(service.assertMemberWaiverAccepted('studio-1', 'user-1')).resolves.not.toThrow();
      expect(prisma.waiverAcceptance.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─── createSelfAcceptance ────────────────────────────────────────────────
  describe('createSelfAcceptance', () => {
    it('creates acceptance with metadata', async () => {
      prisma.studioWaiverDocument.findFirst.mockResolvedValue({ ...activeDoc, isActive: true });
      prisma.waiverAcceptance.findUnique.mockResolvedValue(null);
      prisma.waiverAcceptance.create.mockResolvedValue({ id: 'acc-1', method: WaiverAcceptanceMethod.SELF });

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

    it('is idempotent — returns existing acceptance without creating duplicate', async () => {
      prisma.studioWaiverDocument.findFirst.mockResolvedValue({ ...activeDoc, isActive: true });
      prisma.waiverAcceptance.findUnique.mockResolvedValue({ id: 'acc-existing' });

      const result = await service.createSelfAcceptance({
        studioId: 'studio-1',
        userId: 'user-1',
        waiverDocumentId: 'doc-1',
      });

      expect(result).toEqual({ id: 'acc-existing' });
      expect(prisma.waiverAcceptance.create).not.toHaveBeenCalled();
    });

    it('throws when document is not found or not active', async () => {
      prisma.studioWaiverDocument.findFirst.mockResolvedValue(null);

      await expect(
        service.createSelfAcceptance({
          studioId: 'studio-1',
          userId: 'user-1',
          waiverDocumentId: 'doc-GONE',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── createSelfAcceptanceInTx ─────────────────────────────────────────────
  describe('createSelfAcceptanceInTx', () => {
    it('creates acceptance without checking isActive (TOCTOU fix)', async () => {
      const tx = {
        studioWaiverDocument: {
          findFirst: jest.fn().mockResolvedValue({ id: 'doc-1', version: '2026-07-01-v1' }),
        },
        waiverAcceptance: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'acc-new' }),
        },
      };

      await service.createSelfAcceptanceInTx(tx as never, {
        studioId: 'studio-1',
        userId: 'user-1',
        waiverDocumentId: 'doc-1',
      });

      // Must query by ID only (no isActive filter)
      expect(tx.studioWaiverDocument.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'doc-1', studioId: 'studio-1' },
        }),
      );
      // Must NOT include isActive in the where clause
      expect(tx.studioWaiverDocument.findFirst.mock.calls[0][0].where).not.toHaveProperty('isActive');

      expect(tx.waiverAcceptance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            waiverDocumentId: 'doc-1',
            waiverVersion: '2026-07-01-v1',
            method: WaiverAcceptanceMethod.SELF,
          }),
        }),
      );
    });

    it('is idempotent — no duplicate created if acceptance already exists', async () => {
      const tx = {
        studioWaiverDocument: {
          findFirst: jest.fn().mockResolvedValue({ id: 'doc-1', version: 'v1' }),
        },
        waiverAcceptance: {
          findUnique: jest.fn().mockResolvedValue({ id: 'acc-existing' }),
          create: jest.fn(),
        },
      };

      await service.createSelfAcceptanceInTx(tx as never, {
        studioId: 'studio-1',
        userId: 'user-1',
        waiverDocumentId: 'doc-1',
      });

      expect(tx.waiverAcceptance.create).not.toHaveBeenCalled();
    });

    it('throws if document not found by ID', async () => {
      const tx = {
        studioWaiverDocument: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
        waiverAcceptance: { findUnique: jest.fn(), create: jest.fn() },
      };

      await expect(
        service.createSelfAcceptanceInTx(tx as never, {
          studioId: 'studio-1',
          userId: 'user-1',
          waiverDocumentId: 'doc-MISSING',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── getWaiverStatus ──────────────────────────────────────────────────────
  describe('getWaiverStatus', () => {
    it('returns required=false accepted=true when no active waiver exists', async () => {
      prisma.studioWaiverDocument.findFirst.mockResolvedValue(null);
      const status = await service.getWaiverStatus('studio-1', 'user-1');
      expect(status).toMatchObject({ required: false, accepted: true });
    });

    it('returns required=true accepted=false when acceptance is missing', async () => {
      prisma.waiverAcceptance.findUnique.mockResolvedValue(null);
      const status = await service.getWaiverStatus('studio-1', 'user-1');
      expect(status).toMatchObject({ required: true, accepted: false });
    });

    it('returns required=true accepted=true when acceptance exists', async () => {
      prisma.waiverAcceptance.findUnique.mockResolvedValue({
        waiverVersion: '2026-07-01-v1',
        acceptedAt: new Date(),
        method: WaiverAcceptanceMethod.SELF,
      });
      const status = await service.getWaiverStatus('studio-1', 'user-1');
      expect(status).toMatchObject({ required: true, accepted: true });
    });
  });
});
