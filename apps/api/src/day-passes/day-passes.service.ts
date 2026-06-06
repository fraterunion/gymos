import { Injectable } from '@nestjs/common';
import { DayPassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { DayPassResponseDto } from './dto/day-pass-response.dto';

@Injectable()
export class DayPassesService {
  constructor(private readonly prisma: PrismaService) {}

  async listMyDayPasses(studioId: string, userId: string): Promise<DayPassResponseDto[]> {
    return this.prisma.dayPass.findMany({
      where: {
        studioId,
        userId,
        status: { in: [DayPassStatus.PENDING, DayPassStatus.ACTIVE] },
      },
      select: {
        id: true,
        validForDate: true,
        status: true,
        priceCents: true,
        currency: true,
        createdAt: true,
      },
      orderBy: { validForDate: 'desc' },
    });
  }
}
