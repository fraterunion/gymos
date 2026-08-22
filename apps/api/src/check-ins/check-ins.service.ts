import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { MANUAL_ATTENDANCE_ROLES } from '../auth/desk-roles';
import { acquireMembershipUsageAdvisoryLock } from '../membership-usage/membership-usage-advisory-lock';
import { MembershipUsageService } from '../membership-usage/membership-usage.service';
import { currentlyEntitledSubscriptionWhere, MEMBERSHIP_EXPIRED_MESSAGE } from '../memberships/membership-entitlement';
import { assertEligibleForCheckIn } from './check-in-eligibility';
import { CHECK_IN_LATE_GRACE_MINUTES, isWithinCheckInWindow } from './check-in-window.utils';
import {
  isClassIncludedInPlan,
  MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE,
} from '../membership-plans/membership-plan-class-access.utils';
import { WalletCredentialService } from '../wallet/wallet-credential.service';
import { isWalletCredentialBarcode } from '../wallet/wallet-credential.constants';
import {
  WALLET_ALREADY_CHECKED_IN_MESSAGE,
  WALLET_CREDENTIAL_INVALID_MESSAGE,
  WALLET_CREDENTIAL_REVOKED_MESSAGE,
  WALLET_MEMBER_NOT_ACTIVE_MESSAGE,
  WALLET_MULTIPLE_ELIGIBLE_BOOKINGS_CODE,
  WALLET_NO_ELIGIBLE_BOOKING_MESSAGE,
  WALLET_WRONG_STUDIO_MESSAGE,
  type WalletEligibleBookingCandidate,
} from './wallet-checkin.constants';

const ENTITLEMENT_OVERRIDE_ROLES: ReadonlySet<Role> = new Set([Role.ADMIN, Role.OWNER]);

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

const manualAttendanceRoles: ReadonlySet<Role> = new Set(MANUAL_ATTENDANCE_ROLES);

const manualAttendanceClassStatuses: ReadonlySet<ClassStatus> = new Set([
  ClassStatus.SCHEDULED,
  ClassStatus.COMPLETED,
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
  private readonly logger = new Logger(CheckInsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly waiverService: WaiverService,
    private readonly membershipUsage: MembershipUsageService,
    private readonly walletCredentials: WalletCredentialService,
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

  /**
   * Dispatches on barcode format — the mobile Front Desk scanner is a content-agnostic
   * pipe (whatever string the camera reads is sent verbatim as `qrToken`), so routing here
   * server-side means zero scanner/client changes for either credential type, now or for
   * any future prefix. A raw JWT never starts with "gymos:v1:" (and a wallet credential
   * never contains the two dots a JWT always has), so there is no ambiguity to resolve.
   */
  async checkInWithQr(
    studioId: string,
    actorUserId: string,
    qrTokenRaw: string,
  ): Promise<AttendanceSummary> {
    if (isWalletCredentialBarcode(qrTokenRaw)) {
      return this.checkInWithWalletCredential(studioId, actorUserId, qrTokenRaw);
    }
    return this.checkInWithBookingQrJwt(studioId, actorUserId, qrTokenRaw);
  }

  private async checkInWithBookingQrJwt(
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

      return this.performCheckIn(tx, {
        studioId,
        scheduledClassId: booking.scheduledClassId,
        userId: booking.userId,
        method: CheckInMethod.QR,
        checkedInByUserId: null,
      });
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

    return this.performCheckIn(this.prisma, {
      studioId,
      scheduledClassId: booking.scheduledClassId,
      userId: booking.userId,
      method: CheckInMethod.MANUAL,
      checkedInByUserId: actorUserId,
    });
  }

  /**
   * Wallet credential -> member identity -> this member's currently-eligible booking(s),
   * using the exact same eligibility rules (assertBookingAndClassEligibleForCheckIn /
   * isWithinCheckInWindow) the booking-QR and manual paths already enforce. The credential
   * itself is never authoritative — it only resolves who is scanning; a member whose
   * entitlement changed after a CONFIRMED booking was made gets the SAME outcome here as
   * they would via booking QR or manual check-in (see check-in-eligibility.ts — entitlement
   * is not re-checked once a booking is CONFIRMED, by existing, unchanged design).
   * Never creates a booking, never consumes a credit, never picks between multiple
   * candidates — ambiguity is returned to Front Desk for explicit resolution.
   */
  private async checkInWithWalletCredential(
    studioId: string,
    actorUserId: string,
    barcodeValue: string,
  ): Promise<AttendanceSummary> {
    await this.requireStaffCheckInRole(studioId, actorUserId);

    const resolution = await this.walletCredentials.resolve(barcodeValue);
    if (resolution.status === 'invalid') {
      this.logWalletCheckInDenied(studioId, null, WALLET_CREDENTIAL_INVALID_MESSAGE);
      throw new UnauthorizedException(WALLET_CREDENTIAL_INVALID_MESSAGE);
    }
    if (resolution.status === 'revoked') {
      this.logWalletCheckInDenied(studioId, resolution.credential.id, WALLET_CREDENTIAL_REVOKED_MESSAGE);
      throw new UnauthorizedException(WALLET_CREDENTIAL_REVOKED_MESSAGE);
    }

    const { credential } = resolution;

    if (credential.studioId !== studioId) {
      this.logWalletCheckInDenied(studioId, credential.id, WALLET_WRONG_STUDIO_MESSAGE);
      throw new ForbiddenException(WALLET_WRONG_STUDIO_MESSAGE);
    }

    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: credential.userId, deletedAt: null },
      select: {
        userId: true,
        user: { select: { deletedAt: true, firstName: true, lastName: true } },
      },
    });
    if (!membership || membership.user.deletedAt) {
      this.logWalletCheckInDenied(studioId, credential.id, WALLET_MEMBER_NOT_ACTIVE_MESSAGE);
      throw new ForbiddenException(WALLET_MEMBER_NOT_ACTIVE_MESSAGE);
    }

    const now = new Date();
    const resolved = await this.resolveEligibleBookingForMember(studioId, credential.userId, now);

    if (resolved.outcome === 'already_checked_in') {
      this.logWalletCheckInDenied(studioId, credential.id, WALLET_ALREADY_CHECKED_IN_MESSAGE);
      throw new ConflictException(WALLET_ALREADY_CHECKED_IN_MESSAGE);
    }
    if (resolved.outcome === 'none') {
      this.logWalletCheckInDenied(studioId, credential.id, WALLET_NO_ELIGIBLE_BOOKING_MESSAGE);
      throw new ConflictException(WALLET_NO_ELIGIBLE_BOOKING_MESSAGE);
    }
    if (resolved.outcome === 'multiple') {
      this.logger.log(
        JSON.stringify({
          event: 'wallet.checkin.multiple_candidates',
          studioId,
          walletCredentialId: credential.id,
          candidateCount: resolved.candidates.length,
        }),
      );
      throw new ConflictException({
        statusCode: 409,
        code: WALLET_MULTIPLE_ELIGIBLE_BOOKINGS_CODE,
        message: WALLET_MULTIPLE_ELIGIBLE_BOOKINGS_CODE,
        // Safe to include: Front Desk just scanned this exact member's own credential and is
        // about to check them in — this is not new exposure, just naming who staff are already
        // looking at, so the disambiguation UI can say "Selecciona la clase de <name>" instead
        // of a bare list of times.
        memberName: `${membership.user.firstName} ${membership.user.lastName}`.trim(),
        candidates: resolved.candidates,
      });
    }

    const { booking } = resolved;
    const attendance = await this.prisma.$transaction(async (tx) => {
      // Re-validate inside the transaction — resolveEligibleBookingForMember ran outside
      // one purely to compute the 0/1/N decision; the actual write re-asserts eligibility
      // and relies on the same P2002-on-duplicate-attendance guard as every other path.
      await this.assertBookingAndClassEligibleForCheckIn(booking, booking.scheduledClass, new Date());
      return this.performCheckIn(tx, {
        studioId,
        scheduledClassId: booking.scheduledClassId,
        userId: booking.userId,
        method: CheckInMethod.QR,
        checkedInByUserId: null,
      });
    });

    await this.walletCredentials.touchLastUsed(credential.id);
    this.logger.log(
      JSON.stringify({
        event: 'wallet.checkin.resolved',
        studioId,
        walletCredentialId: credential.id,
        outcome: 'checked_in',
      }),
    );
    return attendance;
  }

  private logWalletCheckInDenied(studioId: string, walletCredentialId: string | null, reason: string): void {
    this.logger.log(
      JSON.stringify({ event: 'wallet.checkin.denied', studioId, walletCredentialId, reason }),
    );
  }

  /**
   * Bounds the candidate query to the widest possible check-in window (studio's
   * checkInWindowMinutes early-open + the fixed 30-minute late grace) so the SQL filter and
   * isWithinCheckInWindow's own inequality can never disagree — the JS filter below is
   * defense-in-depth, not the source of truth for the boundary math.
   */
  private async resolveEligibleBookingForMember(
    studioId: string,
    userId: string,
    now: Date,
  ): Promise<
    | { outcome: 'none' }
    | { outcome: 'already_checked_in' }
    | { outcome: 'multiple'; candidates: WalletEligibleBookingCandidate[] }
    | {
        outcome: 'one';
        booking: Prisma.BookingGetPayload<{
          include: { scheduledClass: { include: { classTemplate: { select: { name: true } } } } };
        }>;
      }
  > {
    const studio = await this.prisma.studio.findFirst({
      where: { id: studioId, deletedAt: null },
      select: { checkInWindowMinutes: true },
    });
    if (!studio) {
      throw new NotFoundException('Studio not found');
    }

    const earlyOpenMs = studio.checkInWindowMinutes * 60_000;
    const lateGraceMs = CHECK_IN_LATE_GRACE_MINUTES * 60_000;
    const lowerBound = new Date(now.getTime() - lateGraceMs);
    const upperBound = new Date(now.getTime() + earlyOpenMs);

    const bookings = await this.prisma.booking.findMany({
      where: {
        studioId,
        userId,
        status: BookingStatus.CONFIRMED,
        scheduledClass: {
          status: ClassStatus.SCHEDULED,
          startsAt: { gte: lowerBound, lte: upperBound },
        },
      },
      include: {
        scheduledClass: { include: { classTemplate: { select: { name: true } } } },
      },
      orderBy: { scheduledClass: { startsAt: 'asc' } },
    });

    const withinWindow = bookings.filter((b) =>
      isWithinCheckInWindow(b.scheduledClass.startsAt, now, studio.checkInWindowMinutes),
    );

    if (withinWindow.length === 0) {
      return { outcome: 'none' };
    }

    const attendances = await this.prisma.attendance.findMany({
      where: {
        studioId,
        userId,
        scheduledClassId: { in: withinWindow.map((b) => b.scheduledClassId) },
      },
      select: { scheduledClassId: true },
    });
    const attendedIds = new Set(attendances.map((a) => a.scheduledClassId));
    const unattended = withinWindow.filter((b) => !attendedIds.has(b.scheduledClassId));

    if (unattended.length === 0) {
      return { outcome: 'already_checked_in' };
    }
    if (unattended.length === 1) {
      return { outcome: 'one', booking: unattended[0]! };
    }
    return {
      outcome: 'multiple',
      candidates: unattended.map((b) => ({
        bookingId: b.id,
        scheduledClassId: b.scheduledClassId,
        className: b.scheduledClass.classTemplate.name,
        startsAt: b.scheduledClass.startsAt.toISOString(),
      })),
    };
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

  async registerManualClassAttendance(
    studioId: string,
    scheduledClassId: string,
    memberId: string,
    actorUserId: string,
    overrideEntitlement?: boolean,
    overrideReason?: string,
  ): Promise<AttendanceSummary> {
    this.logger.log(
      JSON.stringify({
        event: 'registerManualClassAttendance.start',
        studioId,
        scheduledClassId,
        memberId,
        actorUserId,
      }),
    );

    await this.requireManualAttendanceRole(studioId, actorUserId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        this.logger.log(JSON.stringify({ event: 'registerManualClassAttendance.lock' }));
        await acquireMembershipUsageAdvisoryLock(tx, studioId, memberId);

        const now = new Date();
        const [membership, scheduledClass, activeSubscription] = await Promise.all([
          tx.studioMembership.findFirst({
            where: {
              studioId,
              userId: memberId,
              deletedAt: null,
              role: Role.MEMBER,
            },
            include: {
              user: { select: { ...attendanceUserSelect, deletedAt: true } },
            },
          }),
          tx.scheduledClass.findFirst({
            where: { id: scheduledClassId, studioId },
            include: { classTemplate: { select: { id: true, name: true, category: true } } },
          }),
          tx.subscription.findFirst({
            where: {
              studioId,
              userId: memberId,
              ...currentlyEntitledSubscriptionWhere(now),
            },
            select: {
              id: true,
              currentPeriodStart: true,
              currentPeriodEnd: true,
              entitlementEndsAt: true,
              membershipPlan: {
                select: {
                  id: true,
                  name: true,
                  classCredits: true,
                  entitlementDays: true,
                  allClassesAccess: true,
                  allowedCategories: true,
                  classTemplateAccess: { select: { classTemplateId: true } },
                },
              },
            },
          }),
        ]);

        if (!scheduledClass) {
          throw new NotFoundException('Class not found');
        }
        this.logger.log(
          JSON.stringify({
            event: 'registerManualClassAttendance.foundClass',
            classStatus: scheduledClass.status,
          }),
        );

        if (!membership || membership.user.deletedAt) {
          throw new NotFoundException('Member not found');
        }
        this.logger.log(
          JSON.stringify({
            event: 'registerManualClassAttendance.foundMembership',
            membershipId: membership.id,
            userId: membership.userId,
          }),
        );

        if (!activeSubscription) {
          throw new BadRequestException(
            MEMBERSHIP_EXPIRED_MESSAGE,
          );
        }
        this.logger.log(JSON.stringify({ event: 'registerManualClassAttendance.foundSubscription' }));

        if (scheduledClass.status === ClassStatus.CANCELLED) {
          throw new ConflictException('Cannot register attendance for a cancelled class.');
        }
        if (!manualAttendanceClassStatuses.has(scheduledClass.status)) {
          throw new ConflictException('Cannot register attendance for this class.');
        }

        const existing = await tx.attendance.findUnique({
          where: {
            scheduledClassId_userId: {
              scheduledClassId,
              userId: memberId,
            },
          },
        });
        if (existing) {
          throw new ConflictException('Attendance already registered.');
        }

        // Class template entitlement check — must happen before credit check.
        // Staff cannot silently book an incompatible plan member into a restricted class.
        const { allClassesAccess, allowedCategories, classTemplateAccess, id: planId, name: planName } =
          activeSubscription.membershipPlan;
        const allowedTemplateIds = classTemplateAccess.map((a) => a.classTemplateId);

        const hasTemplateAccess = isClassIncludedInPlan({
          allClassesAccess,
          allowedTemplateIds,
          allowedCategories,
          classTemplateId: scheduledClass.classTemplate.id,
          templateCategory: scheduledClass.classTemplate.category,
        });

        if (!hasTemplateAccess) {
          if (!overrideEntitlement) {
            throw new ForbiddenException(MEMBERSHIP_CLASS_ACCESS_DENIED_MESSAGE);
          }

          // Override: ADMIN or OWNER only, mandatory reason, audit log.
          const actor = await tx.studioMembership.findFirst({
            where: { studioId, userId: actorUserId, deletedAt: null },
          });
          if (!actor || !ENTITLEMENT_OVERRIDE_ROLES.has(actor.role)) {
            throw new ForbiddenException('Entitlement override requires ADMIN or OWNER role.');
          }
          if (!overrideReason?.trim()) {
            throw new BadRequestException('overrideReason is required when overriding class entitlement.');
          }

          await tx.auditLog.create({
            data: {
              studioId,
              actorUserId,
              action: 'ENTITLEMENT_OVERRIDE_MANUAL_ATTENDANCE',
              targetUserId: memberId,
              entityType: 'ScheduledClass',
              entityId: scheduledClassId,
              metadata: {
                reason: overrideReason,
                classTemplateId: scheduledClass.classTemplate.id,
                classTemplateName: scheduledClass.classTemplate.name,
                membershipPlanId: planId,
                membershipPlanName: planName,
              },
            },
          });

          this.logger.log(
            JSON.stringify({
              event: 'registerManualClassAttendance.entitlementOverride',
              actorUserId,
              memberId,
              scheduledClassId,
              membershipPlanId: planId,
            }),
          );
        }

        this.logger.log(JSON.stringify({ event: 'registerManualClassAttendance.assertCredits' }));
        // Use entitlementEndsAt as the effective period end for fixed-duration plans.
        const subForCredits = {
          ...activeSubscription,
          currentPeriodEnd: activeSubscription.entitlementEndsAt ?? activeSubscription.currentPeriodEnd,
        };
        await this.membershipUsage.assertCreditAvailableForClass(
          tx,
          studioId,
          memberId,
          scheduledClassId,
          scheduledClass.startsAt,
          subForCredits,
          { errorType: 'bad_request' },
        );

        this.logger.log(JSON.stringify({ event: 'registerManualClassAttendance.createAttendance' }));
        try {
          const attendance = await tx.attendance.create({
            data: {
              studioId,
              scheduledClassId,
              userId: memberId,
              method: CheckInMethod.MANUAL,
              checkedInByUserId: actorUserId,
            },
            include: { user: { select: attendanceUserSelect } },
          });
          this.logger.log(
            JSON.stringify({
              event: 'registerManualClassAttendance.done',
              attendanceId: attendance.id,
            }),
          );
          return this.toAttendanceSummary(attendance);
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
            throw new ConflictException('Attendance already registered.');
          }
          throw e;
        }
      });
    } catch (e) {
      this.logger.error(
        JSON.stringify({
          event: 'registerManualClassAttendance.failed',
          studioId,
          scheduledClassId,
          memberId,
          actorUserId,
          error: e instanceof Error ? e.message : String(e),
        }),
        e instanceof Error ? e.stack : undefined,
      );
      throw e;
    }
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

  private async requireManualAttendanceRole(studioId: string, actorUserId: string) {
    const membership = await this.prisma.studioMembership.findFirst({
      where: { studioId, userId: actorUserId, deletedAt: null },
    });
    if (!membership || !manualAttendanceRoles.has(membership.role)) {
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

  /**
   * The single canonical write shared by every check-in path (booking QR, manual,
   * Wallet): create the Attendance row, or surface the existing unique-constraint
   * violation as the same "Already checked in" conflict every path has always thrown.
   * `db` accepts either `this.prisma` or a `Prisma.TransactionClient` — booking QR and
   * Wallet check-in call this from inside a transaction; manual check-in does not need one
   * (a single insert has nothing else to be atomic with) and passes `this.prisma` directly,
   * unchanged from its pre-refactor behavior.
   */
  private async performCheckIn(
    db: Prisma.TransactionClient | PrismaService,
    input: {
      studioId: string;
      scheduledClassId: string;
      userId: string;
      method: CheckInMethod;
      checkedInByUserId: string | null;
    },
  ): Promise<AttendanceSummary> {
    try {
      const attendance = await db.attendance.create({
        data: {
          studioId: input.studioId,
          scheduledClassId: input.scheduledClassId,
          userId: input.userId,
          method: input.method,
          checkedInByUserId: input.checkedInByUserId,
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
