import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../sales/audit.service';
import { toAuditMetadata } from '../sales/audit-metadata.utils';
import type { DayPassClassAccessTemplateDto } from './dto/day-pass-class-access.dto';

@Injectable()
export class DayPassClassAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAccess(studioId: string): Promise<DayPassClassAccessTemplateDto[]> {
    const [templates, allowedRows] = await Promise.all([
      this.prisma.classTemplate.findMany({
        where: { studioId, deletedAt: null },
        select: { id: true, name: true, durationMinutes: true, isOpenGymSlot: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.dayPassClassAccess.findMany({
        where: { studioId },
        select: { classTemplateId: true },
      }),
    ]);
    const allowedIds = new Set(allowedRows.map((r) => r.classTemplateId));
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      durationMinutes: t.durationMinutes,
      isOpenGymSlot: t.isOpenGymSlot,
      active: true,
      allowed: allowedIds.has(t.id),
    }));
  }

  async grantAccess(
    studioId: string,
    classTemplateId: string,
    actorUserId?: string,
  ): Promise<void> {
    const template = await this.prisma.classTemplate.findFirst({
      where: { id: classTemplateId, studioId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!template) {
      throw new BadRequestException('Class template not found in this studio.');
    }
    await this.prisma.dayPassClassAccess.upsert({
      where: { studioId_classTemplateId: { studioId, classTemplateId } },
      create: { studioId, classTemplateId },
      update: {},
    });
    if (actorUserId) {
      await this.audit.log({
        studioId,
        actorUserId,
        action: 'DAY_PASS_CLASS_ACCESS_GRANTED',
        entityType: 'day_pass_class_access',
        entityId: classTemplateId,
        metadata: toAuditMetadata({
          classTemplateId,
          classTemplateName: template.name,
        }),
      });
    }
  }

  async revokeAccess(
    studioId: string,
    classTemplateId: string,
    actorUserId?: string,
  ): Promise<void> {
    const template = await this.prisma.classTemplate.findFirst({
      where: { id: classTemplateId, studioId, deletedAt: null },
      select: { id: true, name: true },
    });
    await this.prisma.dayPassClassAccess.deleteMany({
      where: { studioId, classTemplateId },
    });
    if (actorUserId && template) {
      await this.audit.log({
        studioId,
        actorUserId,
        action: 'DAY_PASS_CLASS_ACCESS_REVOKED',
        entityType: 'day_pass_class_access',
        entityId: classTemplateId,
        metadata: toAuditMetadata({
          classTemplateId,
          classTemplateName: template.name,
        }),
      });
    }
  }
}
