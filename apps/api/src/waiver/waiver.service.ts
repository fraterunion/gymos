import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, WaiverAcceptanceMethod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type PublicWaiverDto = {
  id: string;
  studioId: string;
  version: string;
  title: string;
  bodyMarkdown: string;
  effectiveAt: Date;
};

export type WaiverStatusDto = {
  required: boolean;
  accepted: boolean;
  activeVersion: string | null;
  activeWaiverDocumentId: string | null;
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  method: WaiverAcceptanceMethod | null;
};

export type MemberWaiverStatusDto = WaiverStatusDto & {
  userId: string;
};

const WAIVER_REQUIRED_MESSAGE = 'Debes aceptar la Carta Responsiva antes de continuar.';
const REGISTER_WAIVER_MESSAGE = 'Debes aceptar la Carta Responsiva para crear tu cuenta.';

@Injectable()
export class WaiverService {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveWaiverBySlug(slug: string): Promise<PublicWaiverDto | null> {
    const studio = await this.prisma.studio.findFirst({
      where: { slug, deletedAt: null },
      select: { id: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    return this.getActiveWaiver(studio.id);
  }

  async getActiveWaiver(studioId: string): Promise<PublicWaiverDto | null> {
    const doc = await this.prisma.studioWaiverDocument.findFirst({
      where: { studioId, isActive: true },
      orderBy: { effectiveAt: 'desc' },
      select: {
        id: true,
        studioId: true,
        version: true,
        title: true,
        bodyMarkdown: true,
        effectiveAt: true,
      },
    });
    return doc;
  }

  async getWaiverStatus(studioId: string, userId: string): Promise<WaiverStatusDto> {
    const active = await this.getActiveWaiver(studioId);
    if (!active) {
      return {
        required: false,
        accepted: true,
        activeVersion: null,
        activeWaiverDocumentId: null,
        acceptedVersion: null,
        acceptedAt: null,
        method: null,
      };
    }

    const acceptance = await this.prisma.waiverAcceptance.findUnique({
      where: {
        studioId_userId_waiverDocumentId: {
          studioId,
          userId,
          waiverDocumentId: active.id,
        },
      },
      select: {
        waiverVersion: true,
        acceptedAt: true,
        method: true,
      },
    });

    return {
      required: true,
      accepted: Boolean(acceptance),
      activeVersion: active.version,
      activeWaiverDocumentId: active.id,
      acceptedVersion: acceptance?.waiverVersion ?? null,
      acceptedAt: acceptance?.acceptedAt ?? null,
      method: acceptance?.method ?? null,
    };
  }

  async getMemberWaiverStatus(studioId: string, userId: string): Promise<MemberWaiverStatusDto> {
    await this.assertTargetMember(studioId, userId);
    const status = await this.getWaiverStatus(studioId, userId);
    return { userId, ...status };
  }

  async assertMemberWaiverAccepted(studioId: string, userId: string): Promise<void> {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
      select: { role: true },
    });
    if (!membership || membership.role !== Role.MEMBER) {
      return;
    }

    const status = await this.getWaiverStatus(studioId, userId);
    if (status.required && !status.accepted) {
      throw new ForbiddenException(WAIVER_REQUIRED_MESSAGE);
    }
  }

  async validateRegistrationWaiver(params: {
    studioId: string;
    waiverDocumentId?: string;
    waiverAccepted?: boolean;
  }): Promise<{ waiverDocumentId: string } | null> {
    const active = await this.getActiveWaiver(params.studioId);
    if (!active) {
      return null;
    }

    if (!params.waiverAccepted || !params.waiverDocumentId) {
      throw new BadRequestException(REGISTER_WAIVER_MESSAGE);
    }
    if (params.waiverDocumentId !== active.id) {
      throw new BadRequestException('La versión de la Carta Responsiva no es válida.');
    }

    return { waiverDocumentId: active.id };
  }

  async createSelfAcceptance(params: {
    studioId: string;
    userId: string;
    waiverDocumentId: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const doc = await this.prisma.studioWaiverDocument.findFirst({
      where: {
        id: params.waiverDocumentId,
        studioId: params.studioId,
        isActive: true,
      },
    });
    if (!doc) {
      throw new BadRequestException('La Carta Responsiva activa no fue encontrada.');
    }

    const existing = await this.prisma.waiverAcceptance.findUnique({
      where: {
        studioId_userId_waiverDocumentId: {
          studioId: params.studioId,
          userId: params.userId,
          waiverDocumentId: doc.id,
        },
      },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.waiverAcceptance.create({
      data: {
        studioId: params.studioId,
        userId: params.userId,
        waiverDocumentId: doc.id,
        waiverVersion: doc.version,
        method: WaiverAcceptanceMethod.SELF,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    });
  }

  async createStaffAttestation(params: {
    studioId: string;
    targetUserId: string;
    actorUserId: string;
    waiverDocumentId: string;
    attestationNote?: string;
  }) {
    await this.assertTargetMember(params.studioId, params.targetUserId);

    const doc = await this.prisma.studioWaiverDocument.findFirst({
      where: {
        id: params.waiverDocumentId,
        studioId: params.studioId,
        isActive: true,
      },
    });
    if (!doc) {
      throw new BadRequestException('La Carta Responsiva activa no fue encontrada.');
    }

    const existing = await this.prisma.waiverAcceptance.findUnique({
      where: {
        studioId_userId_waiverDocumentId: {
          studioId: params.studioId,
          userId: params.targetUserId,
          waiverDocumentId: doc.id,
        },
      },
    });
    if (existing) {
      throw new ConflictException('Este miembro ya tiene la Carta Responsiva registrada.');
    }

    return this.prisma.waiverAcceptance.create({
      data: {
        studioId: params.studioId,
        userId: params.targetUserId,
        waiverDocumentId: doc.id,
        waiverVersion: doc.version,
        method: WaiverAcceptanceMethod.STAFF_ATTESTED,
        attestedByUserId: params.actorUserId,
        attestationNote: params.attestationNote?.trim() || null,
      },
    });
  }

  private async assertTargetMember(studioId: string, userId: string): Promise<void> {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null, role: Role.MEMBER },
      select: { id: true },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
  }
}

export { REGISTER_WAIVER_MESSAGE, WAIVER_REQUIRED_MESSAGE };
