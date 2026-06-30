import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateOperationalNoteDto } from './dto/create-operational-note.dto';

const authorSelect = {
  id: true,
  firstName: true,
  lastName: true,
} as const;

@Injectable()
export class MemberOperationalNotesService {
  constructor(private readonly prisma: PrismaService) {}

  async listNotes(studioId: string, memberUserId: string, limit = 50) {
    await this.assertMember(studioId, memberUserId);
    return this.prisma.memberOperationalNote.findMany({
      where: { studioId, memberUserId },
      include: { author: { select: authorSelect } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async createNote(
    studioId: string,
    memberUserId: string,
    authorUserId: string,
    dto: CreateOperationalNoteDto,
  ) {
    await this.assertMember(studioId, memberUserId);
    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Note body is required');
    }

    return this.prisma.memberOperationalNote.create({
      data: {
        studioId,
        memberUserId,
        authorUserId,
        body,
      },
      include: { author: { select: authorSelect } },
    });
  }

  private async assertMember(studioId: string, userId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    return membership;
  }
}
