import { Injectable } from '@nestjs/common';
import { BookingStatus, ClassStatus, WaitlistStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(studioId: string) {
    const now = new Date();

    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      activeMembers,
      checkInsToday,
      upcomingClassesToday,
      waitlistCount,
      bookingsLast7d,
      noShowData,
      avgFillResult,
      todayOccupancyResult,
      popularTemplateResult,
      activeCoachResult,
    ] = await Promise.all([
      this.prisma.studioMembership.count({
        where: { studioId, deletedAt: null, user: { deletedAt: null } },
      }),

      this.prisma.attendance.count({
        where: { studioId, checkedInAt: { gte: todayStart, lt: tomorrowStart } },
      }),

      this.prisma.scheduledClass.count({
        where: {
          studioId,
          status: ClassStatus.SCHEDULED,
          startsAt: { gte: now, lt: tomorrowStart },
        },
      }),

      this.prisma.waitlistEntry.count({
        where: { studioId, status: WaitlistStatus.WAITING },
      }),

      this.prisma.booking.count({
        where: {
          studioId,
          createdAt: { gte: sevenDaysAgo },
          status: { not: BookingStatus.CANCELLED },
        },
      }),

      this.prisma.$queryRaw<{ no_show: bigint; total: bigint }[]>`
        SELECT
          COUNT(*) FILTER (WHERE b.status = 'NO_SHOW') AS no_show,
          COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED','NO_SHOW','COMPLETED')) AS total
        FROM bookings b
        JOIN scheduled_classes sc ON sc.id = b.scheduled_class_id
        WHERE b.studio_id = ${studioId}
          AND sc.starts_at < ${now}
          AND sc.starts_at >= ${thirtyDaysAgo}
      `,

      this.prisma.$queryRaw<{ avg_fill: number | null }[]>`
        SELECT AVG(
          CASE WHEN sc.capacity > 0
          THEN CAST(COALESCE(b.confirmed_count, 0) AS float) / sc.capacity * 100
          ELSE NULL END
        ) AS avg_fill
        FROM scheduled_classes sc
        LEFT JOIN (
          SELECT scheduled_class_id, COUNT(*) AS confirmed_count
          FROM bookings
          WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')
          GROUP BY scheduled_class_id
        ) b ON b.scheduled_class_id = sc.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${thirtyDaysAgo}
          AND sc.status != 'CANCELLED'
      `,

      this.prisma.$queryRaw<{ occupancy: number | null }[]>`
        SELECT AVG(
          CASE WHEN sc.capacity > 0
          THEN CAST(COALESCE(b.confirmed_count, 0) AS float) / sc.capacity * 100
          ELSE NULL END
        ) AS occupancy
        FROM scheduled_classes sc
        LEFT JOIN (
          SELECT scheduled_class_id, COUNT(*) AS confirmed_count
          FROM bookings
          WHERE status IN ('CONFIRMED','COMPLETED','NO_SHOW')
          GROUP BY scheduled_class_id
        ) b ON b.scheduled_class_id = sc.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${todayStart}
          AND sc.starts_at < ${tomorrowStart}
          AND sc.status != 'CANCELLED'
      `,

      this.prisma.$queryRaw<
        { id: string; name: string; color: string | null; booking_count: bigint }[]
      >`
        SELECT ct.id, ct.name, ct.color, COUNT(b.id) AS booking_count
        FROM class_templates ct
        JOIN scheduled_classes sc ON sc.class_template_id = ct.id
        JOIN bookings b ON b.scheduled_class_id = sc.id
        WHERE ct.studio_id = ${studioId}
          AND b.created_at >= ${thirtyDaysAgo}
          AND b.status NOT IN ('CANCELLED')
        GROUP BY ct.id, ct.name, ct.color
        ORDER BY booking_count DESC
        LIMIT 1
      `,

      this.prisma.$queryRaw<
        { id: string; first_name: string; last_name: string; class_count: bigint }[]
      >`
        SELECT u.id, u.first_name, u.last_name, COUNT(sc.id) AS class_count
        FROM users u
        JOIN scheduled_classes sc ON sc.instructor_id = u.id
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${thirtyDaysAgo}
          AND sc.status != 'CANCELLED'
        GROUP BY u.id, u.first_name, u.last_name
        ORDER BY class_count DESC
        LIMIT 1
      `,
    ]);

    const noShowRow = noShowData[0];
    const noShowTotal = Number(noShowRow?.total ?? 0);
    const noShowRate = noShowTotal > 0 ? (Number(noShowRow.no_show) / noShowTotal) * 100 : 0;

    const avgFillRaw = avgFillResult[0]?.avg_fill;
    const avgClassFill = typeof avgFillRaw === 'number' ? avgFillRaw : 0;

    const occupancyRaw = todayOccupancyResult[0]?.occupancy;
    const occupancyRateToday = typeof occupancyRaw === 'number' ? occupancyRaw : 0;

    const popularRow = popularTemplateResult[0];
    const mostPopularTemplate = popularRow
      ? {
          id: popularRow.id,
          name: popularRow.name,
          color: popularRow.color,
          bookingCount: Number(popularRow.booking_count),
        }
      : null;

    const coachRow = activeCoachResult[0];
    const mostActiveCoach = coachRow
      ? {
          id: coachRow.id,
          firstName: coachRow.first_name,
          lastName: coachRow.last_name,
          classCount: Number(coachRow.class_count),
        }
      : null;

    return {
      activeMembers,
      checkInsToday,
      upcomingClassesToday,
      occupancyRateToday: Math.round(occupancyRateToday * 10) / 10,
      waitlistCount,
      noShowRate: Math.round(noShowRate * 10) / 10,
      avgClassFill: Math.round(avgClassFill * 10) / 10,
      bookingsLast7d,
      mostPopularTemplate,
      mostActiveCoach,
      generatedAt: now.toISOString(),
    };
  }

  async getTrends(studioId: string, days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [bookingRows, attendanceRows] = await Promise.all([
      this.prisma.$queryRaw<{ date: Date; count: bigint }[]>`
        SELECT date_trunc('day', created_at) AS date, COUNT(*) AS count
        FROM bookings
        WHERE studio_id = ${studioId}
          AND created_at >= ${since}
          AND status NOT IN ('CANCELLED')
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<{ date: Date; count: bigint }[]>`
        SELECT date_trunc('day', checked_in_at) AS date, COUNT(*) AS count
        FROM attendances
        WHERE studio_id = ${studioId}
          AND checked_in_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    // Build a complete day map, filling gaps with 0
    const dateMap = new Map<string, { bookings: number; attendances: number }>();
    for (let d = 0; d < days; d++) {
      const day = new Date(since.getTime() + d * 24 * 60 * 60 * 1000);
      const key = day.toISOString().split('T')[0]!;
      dateMap.set(key, { bookings: 0, attendances: 0 });
    }

    for (const row of bookingRows) {
      const key = new Date(row.date).toISOString().split('T')[0]!;
      const entry = dateMap.get(key);
      if (entry) entry.bookings = Number(row.count);
    }
    for (const row of attendanceRows) {
      const key = new Date(row.date).toISOString().split('T')[0]!;
      const entry = dateMap.get(key);
      if (entry) entry.attendances = Number(row.count);
    }

    const sorted = [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b));

    return {
      period: { from: since.toISOString(), to: now.toISOString(), days },
      bookings: sorted.map(([date, v]) => ({ date, count: v.bookings })),
      attendances: sorted.map(([date, v]) => ({ date, count: v.attendances })),
    };
  }

  async getClassBreakdown(studioId: string, days: number) {
    const now = new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const [topTemplates, peakHours] = await Promise.all([
      this.prisma.$queryRaw<
        { template_id: string; name: string; color: string | null; booking_count: bigint }[]
      >`
        SELECT ct.id AS template_id, ct.name, ct.color,
               COUNT(b.id) AS booking_count
        FROM class_templates ct
        JOIN scheduled_classes sc ON sc.class_template_id = ct.id
        LEFT JOIN bookings b
          ON b.scheduled_class_id = sc.id
         AND b.status NOT IN ('CANCELLED')
        WHERE ct.studio_id = ${studioId}
          AND ct.deleted_at IS NULL
          AND sc.starts_at >= ${since}
        GROUP BY ct.id, ct.name, ct.color
        ORDER BY booking_count DESC
        LIMIT 8
      `,
      this.prisma.$queryRaw<{ hour: number; count: bigint }[]>`
        SELECT EXTRACT(HOUR FROM sc.starts_at)::int AS hour,
               COUNT(b.id) AS count
        FROM scheduled_classes sc
        LEFT JOIN bookings b
          ON b.scheduled_class_id = sc.id
         AND b.status NOT IN ('CANCELLED')
        WHERE sc.studio_id = ${studioId}
          AND sc.starts_at >= ${since}
          AND sc.status != 'CANCELLED'
        GROUP BY 1
        ORDER BY 1
      `,
    ]);

    return {
      topTemplates: topTemplates.map((r) => ({
        templateId: r.template_id,
        name: r.name,
        color: r.color,
        bookingCount: Number(r.booking_count),
      })),
      peakHours: peakHours.map((r) => ({
        hour: r.hour,
        count: Number(r.count),
      })),
    };
  }
}
