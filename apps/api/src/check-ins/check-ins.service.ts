import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BookingStatus,
  CheckInMethod,
  ClassStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { JwtPayload } from 'jsonwebtoken';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../prisma/prisma.service';
import { WaiverService } from '../waiver/waiver.service';
import { assertEligibleForCheckIn } from './check-in-eligibility';

const QR_TTL_SECONDS = 5 * 60;

const attendanceUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
} satisfies Prisma.UserSelect;

const staffCheckInRoles: ReadonlySet<Role> = new Set([
  Role.FRONT_DESK,
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
]);

export type QrTokenResponse = {
  qrToken: string;
  expiresAt: Date;
};

export type AttendanceSummary = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  checkInMethod: CheckInMethod;
  checkedInAt: Date;
  checkedInByUserId: string | null;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

type QrJwtPayload = {
  sub: string;
  studioId: string;
  bookingId: string;
};

type AttendanceWithUser = Prisma.AttendanceGetPayload<{
  include: { user: { select: typeof attendanceUserSelect } };
}>;

function hashQrToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function isQrJwtPayload(v: JwtPayload | string): v is QrJwtPayload & JwtPayload {
  if (typeof v === 'string' || v === null || typeof v !== 'object') {
    return false;
  }
  return (
    typeof v['sub'] === 'string' &&
    typeof v['studioId'] === 'string' &&
    typeof v['bookingId'] === 'string'
  );
}

@Injectable()
export class CheckInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly waiverService: WaiverService,
  ) {}

  async generateQrForBooking(
    studioId: string,
    bookingId: string,
    actorUserId: string,
  ): Promise<QrTokenResponse> {
    await this.waiverService.assertMemberWaiverAccepted(studioId, actorUserId);

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId },
      include: {
        user: { select: { deletedAt: true } },
        scheduledClass: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.user.deletedAt) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== actorUserId) {
      throw new ForbiddenException();
    }
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException('Only confirmed bookings can generate a QR code');
    }

    const secret = this.config.getOrThrow<string>('JWT_QR_SECRET');
    const jti = randomUUID();
    const qrToken = jwt.sign(
      { sub: booking.userId, studioId, bookingId, jti },
      secret,
      { expiresIn: QR_TTL_SECONDS, algorithm: 'HS256' },
    );
    const decoded = jwt.decode(qrToken);
    if (!decoded || typeof decoded === 'string' || typeof decoded['exp'] !== 'number') {
      throw new Error('Failed to decode QR JWT');
    }
    const expiresAt = new Date(decoded['exp'] * 1000);
    const tokenHash = hashQrToken(qrToken);

    await this.prisma.qRToken.create({
      data: {
        studioId,
        tokenHash,
        userId: booking.userId,
        scheduledClassId: booking.scheduledClassId,
        expiresAt,
      },
    });

    return { qrToken, expiresAt };
  }

  async checkInWithQr(
    studioId: string,
    actorUserId: string,
    qrTokenRaw: string,
  ): Promise<AttendanceSummary> {
    await this.requireStaffCheckInRole(studioId, actorUserId);

    let payload: QrJwtPayload;
    try {
      const secret = this.config.getOrThrow<string>('JWT_QR_SECRET');
      const verified = jwt.verify(qrTokenRaw, secret, { algorithms: ['HS256'] });
      if (!isQrJwtPayload(verified)) {
        throw new UnauthorizedException('Invalid QR token');
      }
      payload = verified;
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        throw e;
      }
      throw new UnauthorizedException('Invalid or expired QR token');
    }

    if (payload.studioId !== studioId) {
      throw new ForbiddenException();
    }

    const tokenHash = hashQrToken(qrTokenRaw);

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const claim = await tx.qRToken.updateMany({
        where: {
          studioId,
          tokenHash,
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (claim.count === 0) {
        throw new ConflictException('QR token already used or expired');
      }

      const qrRow = await tx.qRToken.findUniqueOrThrow({
        where: { tokenHash },
      });
      if (qrRow.studioId !== studioId) {
        throw new ForbiddenException();
      }

      const booking = await tx.booking.findFirst({
        where: { id: payload.bookingId, studioId },
        include: {
          user: { select: { deletedAt: true } },
          scheduledClass: true,
        },
      });
      if (!booking) {
        throw new UnauthorizedException('Invalid QR token');
      }
      if (booking.user.deletedAt) {
        throw new ForbiddenException();
      }
      if (booking.userId !== payload.sub) {
        throw new UnauthorizedException('Invalid QR token');
      }
      if (
        qrRow.userId !== booking.userId ||
        qrRow.scheduledClassId !== booking.scheduledClassId
      ) {
        throw new UnauthorizedException('Invalid QR token');
      }

      await this.assertBookingAndClassEligibleForCheckIn(booking, booking.scheduledClass, now);

      try {
        const attendance = await tx.attendance.create({
          data: {
            studioId,
            scheduledClassId: booking.scheduledClassId,
            userId: booking.userId,
            method: CheckInMethod.QR,
            checkedInByUserId: null,
          },
          include: { user: { select: attendanceUserSelect } },
        });
        return this.toAttendanceSummary(attendance);
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('Already checked in');
        }
        throw e;
      }
    });
  }

  async checkInManual(
    studioId: string,
    actorUserId: string,
    bookingId: string,
  ): Promise<AttendanceSummary> {
    await this.requireStaffCheckInRole(studioId, actorUserId);

    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId },
      include: {
        user: { select: { deletedAt: true } },
        scheduledClass: true,
      },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.user.deletedAt) {
      throw new ForbiddenException();
    }

    const now = new Date();
    await this.assertBookingAndClassEligibleForCheckIn(booking, booking.scheduledClass, now);

    try {
      const attendance = await this.prisma.attendance.create({
        data: {
          studioId,
          scheduledClassId: booking.scheduledClassId,
          userId: booking.userId,
          method: CheckInMethod.MANUAL,
          checkedInByUserId: actorUserId,
        },
        include: { user: { select: attendanceUserSelect } },
      });
      return this.toAttendanceSummary(attendance);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Already checked in');
      }
      throw e;
    }
  }

  async getBookingAttendance(
    studioId: string,
    bookingId: string,
    actorUserId: string,
  ): Promise<{ attendance: AttendanceSummary | null }> {
    const booking = await this.prisma.booking.findFirst({
      where: { id: bookingId, studioId },
      include: { user: { select: { deletedAt: true } } },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.user.deletedAt) {
      throw new NotFoundException('Booking not found');
    }

    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!membership) {
      throw new ForbiddenException();
    }
    const canView =
      booking.userId === actorUserId || staffCheckInRoles.has(membership.role);
    if (!canView) {
      throw new ForbiddenException();
    }

    const row = await this.prisma.attendance.findUnique({
      where: {
        scheduledClassId_userId: {
          scheduledClassId: booking.scheduledClassId,
          userId: booking.userId,
        },
      },
      include: {
        user: { select: attendanceUserSelect },
      },
    });
    if (!row) {
      return { attendance: null };
    }
    return { attendance: this.toAttendanceSummary(row) };
  }

  async listClassAttendance(studioId: string, scheduledClassId: string): Promise<AttendanceSummary[]> {
    const cls = await this.prisma.scheduledClass.findFirst({
      where: { id: scheduledClassId, studioId },
    });
    if (!cls) {
      throw new NotFoundException('Class not found');
    }

    const rows = await this.prisma.attendance.findMany({
      where: {
        studioId,
        scheduledClassId,
        user: { deletedAt: null },
      },
      include: {
        user: { select: attendanceUserSelect },
      },
      orderBy: { checkedInAt: 'asc' },
    });
    return rows.map((r) => this.toAttendanceSummary(r));
  }

  private async requireStaffCheckInRole(studioId: string, actorUserId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!membership || !staffCheckInRoles.has(membership.role)) {
      throw new ForbiddenException();
    }
    return membership;
  }

  private async assertBookingAndClassEligibleForCheckIn(
    booking: { status: BookingStatus; studioId: string; scheduledClassId: string },
    scheduledClass: { id: string; status: ClassStatus; startsAt: Date; studioId: string },
    now: Date,
  ): Promise<void> {
    const studio = await this.prisma.studio.findFirst({
      where: { id: booking.studioId, deletedAt: null },
      select: { checkInWindowMinutes: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }
    assertEligibleForCheckIn(
      booking,
      scheduledClass,
      now,
      studio.checkInWindowMinutes,
    );
  }

  private toAttendanceSummary(row: AttendanceWithUser): AttendanceSummary {
    return {
      id: row.id,
      studioId: row.studioId,
      scheduledClassId: row.scheduledClassId,
      userId: row.userId,
      checkInMethod: row.method,
      checkedInAt: row.checkedInAt,
      checkedInByUserId: row.checkedInByUserId,
      user: row.user,
    };
  }
}
