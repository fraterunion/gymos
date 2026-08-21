import { Injectable, NotFoundException } from '@nestjs/common';
import {
  BookingStatus,
  ClassStatus,
  WaitlistStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ScheduleSeriesService } from './schedule-series.service';

const rosterUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
} as const;

export type SessionRosterOperationalStatus = 'RESERVED' | 'ATTENDED' | 'WALK_IN';

export type SessionRosterEntry = {
  userId: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
  bookingId: string | null;
  bookingCreatedAt: string | null;
  attendanceId: string | null;
  checkedInAt: string | null;
  checkInMethod: string | null;
  operationalStatus: SessionRosterOperationalStatus;
  isWalkIn: boolean;
};

export type SessionWaitlistEntry = {
  id: string;
  userId: string;
  position: number;
  status: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

export type SessionOperationalProjection = {
  class: {
    id: string;
    studioId: string;
    classTemplateId: string;
    scheduleTemplateId: string | null;
    instructorId: string | null;
    startsAt: string;
    endsAt: string;
    capacity: number;
    status: ClassStatus;
    cancelReason: string | null;
    exceptionKind: string | null;
    checkInWindowMinutes: number;
    classTemplate: {
      id: string;
      name: string;
      color: string | null;
      category: string | null;
    };
    instructor: {
      id: string;
      firstName: string;
      lastName: string;
    } | null;
  };
  occupancy: {
    capacity: number;
    booked: number;
    available: number;
    waitlist: number;
    attended: number;
  };
  roster: SessionRosterEntry[];
  waitlist: SessionWaitlistEntry[];
  seriesContext: Awaited<ReturnType<ScheduleSeriesService['getOccurrenceSeriesContext']>>;
};

@Injectable()
export class ScheduleSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly series: ScheduleSeriesService,
  ) {}

  async getSessionOperationalProjection(
    studioId: string,
    scheduledClassId: string,
  ): Promise<SessionOperationalProjection> {
    const row = await this.prisma.scheduledClass.findFirst({
      where: {
        id: scheduledClassId,
        studioId,
        classTemplate: { deletedAt: null },
      },
      include: {
        classTemplate: {
          select: { id: true, name: true, color: true, category: true },
        },
        instructor: {
          select: { id: true, firstName: true, lastName: true },
        },
        studio: { select: { checkInWindowMinutes: true } },
      },
    });
    if (!row) {
      throw new NotFoundException('Scheduled class not found');
    }

    const [bookings, attendances, waitlistRows, seriesContext] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          studioId,
          scheduledClassId,
          status: BookingStatus.CONFIRMED,
          user: { deletedAt: null },
        },
        include: { user: { select: rosterUserSelect } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.attendance.findMany({
        where: {
          studioId,
          scheduledClassId,
          user: { deletedAt: null },
        },
        orderBy: { checkedInAt: 'asc' },
      }),
      this.prisma.waitlistEntry.findMany({
        where: {
          studioId,
          scheduledClassId,
          status: WaitlistStatus.WAITING,
          user: { deletedAt: null },
        },
        include: { user: { select: rosterUserSelect } },
        orderBy: { position: 'asc' },
      }),
      this.series.getOccurrenceSeriesContext(studioId, scheduledClassId),
    ]);

    const attendanceByUser = new Map(attendances.map((a) => [a.userId, a]));
    const rosterUserIds = new Set(bookings.map((b) => b.userId));
    const walkInUserIds: string[] = [];

    const roster: SessionRosterEntry[] = bookings.map((booking) => {
      const att = attendanceByUser.get(booking.userId);
      return {
        userId: booking.userId,
        user: booking.user,
        bookingId: booking.id,
        bookingCreatedAt: booking.createdAt.toISOString(),
        attendanceId: att?.id ?? null,
        checkedInAt: att?.checkedInAt.toISOString() ?? null,
        checkInMethod: att?.method ?? null,
        operationalStatus: att ? 'ATTENDED' : 'RESERVED',
        isWalkIn: false,
      };
    });

    for (const att of attendances) {
      if (rosterUserIds.has(att.userId)) continue;
      walkInUserIds.push(att.userId);
    }

    if (walkInUserIds.length > 0) {
      const walkInUsers = await this.prisma.user.findMany({
        where: { id: { in: walkInUserIds }, deletedAt: null },
        select: rosterUserSelect,
      });
      const userById = new Map(walkInUsers.map((u) => [u.id, u]));
      for (const att of attendances) {
        if (rosterUserIds.has(att.userId)) continue;
        const user = userById.get(att.userId);
        if (!user) continue;
        roster.push({
          userId: att.userId,
          user,
          bookingId: null,
          bookingCreatedAt: null,
          attendanceId: att.id,
          checkedInAt: att.checkedInAt.toISOString(),
          checkInMethod: att.method,
          operationalStatus: 'WALK_IN',
          isWalkIn: true,
        });
      }
    }

    const booked = bookings.length;
    const attended = attendances.length;
    const waitlist = waitlistRows.length;

    return {
      class: {
        id: row.id,
        studioId: row.studioId,
        classTemplateId: row.classTemplateId,
        scheduleTemplateId: row.scheduleTemplateId,
        instructorId: row.instructorId,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        capacity: row.capacity,
        status: row.status,
        cancelReason: row.cancelReason,
        exceptionKind: row.exceptionKind,
        checkInWindowMinutes: row.studio.checkInWindowMinutes,
        classTemplate: row.classTemplate,
        instructor: row.instructor,
      },
      occupancy: {
        capacity: row.capacity,
        booked,
        available: Math.max(0, row.capacity - booked),
        waitlist,
        attended,
      },
      roster,
      waitlist: waitlistRows.map((w) => ({
        id: w.id,
        userId: w.userId,
        position: w.position,
        status: w.status,
        createdAt: w.createdAt.toISOString(),
        user: w.user,
      })),
      seriesContext,
    };
  }
}
