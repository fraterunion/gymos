import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MemberProgressClassBreakdownItemDto,
  MemberProgressDto,
  MemberProgressFavoriteClassDto,
  MemberProgressRecentActivityItemDto,
} from './dto/member-progress.dto';
import {
  computeIsoWeekStreaks,
  getCurrentStudioMonthBounds,
  getIsoWeekKey,
} from './progress.utils';

const classTemplateSelect = {
  id: true,
  name: true,
  color: true,
} as const;

@Injectable()
export class ProgressService {
  constructor(private readonly prisma: PrismaService) {}

  async getMemberProgress(
    studioId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<MemberProgressDto> {
    await this.assertMembership(studioId, userId);

    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const timezone = studio.timezone;
    const monthBounds = getCurrentStudioMonthBounds(timezone, now);
    const attendanceWhere = { studioId, userId } as const;
    const monthWhere = {
      ...attendanceWhere,
      scheduledClass: {
        startsAt: {
          gte: monthBounds.start,
          lt: monthBounds.end,
        },
      },
    };

    const [totalCheckIns, monthCheckIns, recentRows, breakdownRows] =
      await Promise.all([
        this.prisma.attendance.count({ where: attendanceWhere }),
        this.prisma.attendance.count({ where: monthWhere }),
        this.prisma.attendance.findMany({
          where: attendanceWhere,
          select: {
            id: true,
            checkedInAt: true,
            scheduledClass: {
              select: {
                startsAt: true,
                classTemplate: { select: classTemplateSelect },
              },
            },
          },
          orderBy: { scheduledClass: { startsAt: 'desc' } },
          take: 10,
        }),
        this.prisma.attendance.findMany({
          where: attendanceWhere,
          select: {
            scheduledClass: {
              select: {
                startsAt: true,
                classTemplate: { select: classTemplateSelect },
              },
            },
          },
        }),
      ]);

    const templateCounts = new Map<
      string,
      {
        classTemplate: (typeof breakdownRows)[number]['scheduledClass']['classTemplate'];
        checkIns: number;
      }
    >();

    const attendedWeeks = new Set<string>();

    for (const row of breakdownRows) {
      const template = row.scheduledClass.classTemplate;
      const existing = templateCounts.get(template.id);
      if (existing) {
        existing.checkIns++;
      } else {
        templateCounts.set(template.id, {
          classTemplate: template,
          checkIns: 1,
        });
      }
      attendedWeeks.add(
        getIsoWeekKey(row.scheduledClass.startsAt, timezone),
      );
    }

    const classBreakdown: MemberProgressClassBreakdownItemDto[] = [...templateCounts.values()]
      .map(({ classTemplate, checkIns }) => ({
        classTemplate,
        checkIns,
      }))
      .sort((a, b) => b.checkIns - a.checkIns || a.classTemplate.name.localeCompare(b.classTemplate.name));

    const favoriteClass: MemberProgressFavoriteClassDto | null = classBreakdown[0]
      ? {
          ...classBreakdown[0].classTemplate,
          checkIns: classBreakdown[0].checkIns,
        }
      : null;

    const { currentStreak, bestStreak } = computeIsoWeekStreaks(
      attendedWeeks,
      getIsoWeekKey(now, timezone),
    );

    const recentActivity: MemberProgressRecentActivityItemDto[] = recentRows.map(
      (row) => ({
        attendanceId: row.id,
        checkedInAt: row.checkedInAt.toISOString(),
        classStartsAt: row.scheduledClass.startsAt.toISOString(),
        classTemplate: row.scheduledClass.classTemplate,
      }),
    );

    return {
      totalCheckIns,
      monthCheckIns,
      currentStreak,
      bestStreak,
      favoriteClass,
      classBreakdown,
      recentActivity,
      period: {
        year: monthBounds.year,
        month: monthBounds.month,
        timezone,
      },
      generatedAt: now.toISOString(),
    };
  }

  private async assertMembership(studioId: string, userId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId, deletedAt: null },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    return membership;
  }
}
