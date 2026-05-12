import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Studio } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdateStudioDto } from './dto/update-studio.dto';

@Injectable()
export class StudiosService {
  constructor(private readonly prisma: PrismaService) {}

  async listStudiosForUser(userId: string) {
    const rows = await this.prisma.studioMembership.findMany({
      where: {
        userId,
        deletedAt: null,
        studio: { deletedAt: null },
        user: { deletedAt: null },
      },
      include: {
        studio: {
          select: {
            id: true,
            name: true,
            slug: true,
            timezone: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      studio: r.studio,
      role: r.role,
    }));
  }

  async getStudioProfile(studioId: string): Promise<Studio> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    return studio;
  }

  async updateStudio(studioId: string, dto: UpdateStudioDto): Promise<Studio> {
    const existing = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException('Studio not found');
    }
    if (dto.slug !== undefined && dto.slug !== existing.slug) {
      const taken = await this.prisma.studio.findFirst({
        where: {
          slug: dto.slug,
          deletedAt: null,
          NOT: { id: studioId },
        },
      });
      if (taken) {
        throw new ConflictException('Slug is already in use');
      }
    }
    const data: Prisma.StudioUpdateInput = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
    };
    if (Object.keys(data).length === 0) {
      return existing;
    }
    return this.prisma.studio.update({
      where: { id: studioId },
      data,
    });
  }
}
