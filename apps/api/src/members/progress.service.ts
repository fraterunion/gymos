import { Injectable, NotFoundException } from '@nestjs/common';
import { CheckInType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OPEN_GYM_LABEL } from '../check-ins/open-gym.constants';
import type {
  LeaderboardDto,
  LeaderboardEntryDto,
  LeaderboardPeriod,
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
  category: true,
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
    // A class visit is dated by when the class ran; an Open Gym visit has no class, so it is
    // dated by when the member walked in. Expressed as an OR rather than switching everything
    // to checkedInAt so class bucketing stays bit-for-bit identical to before.
    const monthWhere = {
      ...attendanceWhere,
      OR: [
        { scheduledClass: { startsAt: { gte: monthBounds.start, lt: monthBounds.end } } },
        {
          type: CheckInType.OPEN_GYM,
          checkedInAt: { gte: monthBounds.start, lt: monthBounds.end },
        },
      ],
    };

    const [totalCheckIns, monthCheckIns, recentRows, breakdownRows] =
      await Promise.all([
        this.prisma.attendance.count({ where: attendanceWhere }),
        this.prisma.attendance.count({ where: monthWhere }),
        this.prisma.attendance.findMany({
          where: attendanceWhere,
          select: {
            type: true,
            checkedInAt: true,
            scheduledClass: {
              select: {
                startsAt: true,
                classTemplate: { select: classTemplateSelect },
                instructor: { select: { firstName: true, lastName: true } },
              },
            },
          },
          orderBy: { checkedInAt: 'desc' },
          take: 10,
        }),
        this.prisma.attendance.findMany({
          where: attendanceWhere,
          select: {
            type: true,
            checkedInAt: true,
            scheduledClass: {
              select: {
                startsAt: true,
                classTemplate: { select: classTemplateSelect },
              },
            },
          },
        }),
      ]);

    type BreakdownTemplate = NonNullable<
      (typeof breakdownRows)[number]['scheduledClass']
    >['classTemplate'];

    const templateCounts = new Map<
      string,
      { classTemplate: BreakdownTemplate; checkIns: number }
    >();

    const attendedWeeks = new Set<string>();

    for (const row of breakdownRows) {
      // Streaks measure showing up, so an Open Gym visit counts. It is dated by check-in time
      // because it has no class to borrow a date from.
      attendedWeeks.add(
        getIsoWeekKey(row.scheduledClass?.startsAt ?? row.checkedInAt, timezone),
      );

      // The class breakdown and favourite class are about classes; independent training has no
      // template to attribute and is intentionally excluded from both.
      if (!row.scheduledClass) {
        continue;
      }
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
    }

    const classBreakdown: MemberProgressClassBreakdownItemDto[] = [...templateCounts.values()]
      .map(({ classTemplate, checkIns }) => ({
        templateId: classTemplate.id,
        className: classTemplate.name,
        category: classTemplate.category,
        count: checkIns,
      }))
      .sort((a, b) => b.count - a.count || a.className.localeCompare(b.className));

    const favoriteClass: MemberProgressFavoriteClassDto | null = classBreakdown[0]
      ? {
          templateId: classBreakdown[0].templateId,
          name: classBreakdown[0].className,
          category: classBreakdown[0].category,
          count: classBreakdown[0].count,
        }
      : null;

    const { currentStreak, bestStreak } = computeIsoWeekStreaks(
      attendedWeeks,
      getIsoWeekKey(now, timezone),
    );

    const recentActivity: MemberProgressRecentActivityItemDto[] = recentRows.map(
      (row) => {
        // Open Gym appears in the feed so it cannot contradict totalCheckIns, which counts it.
        // It has no template, category or coach.
        if (!row.scheduledClass) {
          return {
            date: row.checkedInAt.toISOString(),
            className: OPEN_GYM_LABEL,
            category: null,
            coachName: null,
          };
        }
        const instructor = row.scheduledClass.instructor;
        return {
          date: row.scheduledClass.startsAt.toISOString(),
          className: row.scheduledClass.classTemplate.name,
          category: row.scheduledClass.classTemplate.category,
          coachName: instructor
            ? `${instructor.firstName} ${instructor.lastName}`
            : null,
        };
      },
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

  async getLeaderboard(
    studioId: string,
    callerId: string,
    period: LeaderboardPeriod,
    now: Date = new Date(),
  ): Promise<LeaderboardDto> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { timezone: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    let periodBounds: { start: Date; end: Date } | null = null;
    if (period === 'month') {
      const bounds = getCurrentStudioMonthBounds(studio.timezone, now);
      periodBounds = { start: bounds.start, end: bounds.end };
    }

    const rows = await this.queryLeaderboardRows(studioId, periodBounds);

    // rows already sorted: check_ins DESC, user_id ASC (deterministic tie-break)
    const callerIndex = rows.findIndex((r) => r.user_id === callerId);
    const callerRow = callerIndex >= 0 ? rows[callerIndex] : null;
    const callerRank = callerIndex >= 0 && callerIndex < 5 ? callerIndex + 1 : null;

    const top: LeaderboardEntryDto[] = rows.slice(0, 5).map((row, idx) => {
      const lastInitial = row.last_name.length > 0 ? row.last_name[0] : '';
      const firstInitial = row.first_name.length > 0 ? row.first_name[0].toUpperCase() : '';
      const lastInitialUpper = lastInitial.toUpperCase();
      return {
        rank: idx + 1,
        displayName: lastInitial
          ? `${row.first_name} ${lastInitial.toUpperCase()}.`
          : row.first_name,
        initials: `${firstInitial}${lastInitialUpper}`,
        checkIns: Number(row.check_ins),
      };
    });

    return {
      period,
      top,
      me: {
        rank: callerRank,
        checkIns: callerRow ? Number(callerRow.check_ins) : 0,
      },
      generatedAt: now.toISOString(),
    };
  }

  private async queryLeaderboardRows(
    studioId: string,
    periodBounds: { start: Date; end: Date } | null,
  ): Promise<{ user_id: string; first_name: string; last_name: string; check_ins: bigint }[]> {
    if (periodBounds) {
      return this.prisma.$queryRaw<
        { user_id: string; first_name: string; last_name: string; check_ins: bigint }[]
      >`
        SELECT a.user_id, u.first_name, u.last_name, COUNT(*)::bigint AS check_ins
        FROM attendances a
        -- LEFT JOIN so Open Gym visits (no class) are counted. A class visit is still dated by
        -- its class start, so per-class ranking is unchanged; only Open Gym uses check-in time.
        LEFT JOIN scheduled_classes sc ON sc.id = a.scheduled_class_id
        INNER JOIN studio_memberships sm
          ON sm.user_id = a.user_id
          AND sm.studio_id = a.studio_id
          AND sm.deleted_at IS NULL
        INNER JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL
        WHERE a.studio_id = ${studioId}
          AND COALESCE(sc.starts_at, a.checked_in_at) >= ${periodBounds.start}
          AND COALESCE(sc.starts_at, a.checked_in_at) < ${periodBounds.end}
        GROUP BY a.user_id, u.first_name, u.last_name
        ORDER BY check_ins DESC, a.user_id ASC
      `;
    }
    return this.prisma.$queryRaw<
      { user_id: string; first_name: string; last_name: string; check_ins: bigint }[]
    >`
      SELECT a.user_id, u.first_name, u.last_name, COUNT(*)::bigint AS check_ins
      FROM attendances a
      INNER JOIN studio_memberships sm
        ON sm.user_id = a.user_id
        AND sm.studio_id = a.studio_id
        AND sm.deleted_at IS NULL
      INNER JOIN users u ON u.id = a.user_id AND u.deleted_at IS NULL
      WHERE a.studio_id = ${studioId}
      GROUP BY a.user_id, u.first_name, u.last_name
      ORDER BY check_ins DESC, a.user_id ASC
    `;
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
