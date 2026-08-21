import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BookingStatus, ClassStatus, Prisma, Role } from '@prisma/client';
import * as bookingLockModule from '../booking-class-advisory-lock';
import * as usageLockModule from '../membership-usage/membership-usage-advisory-lock';
import { BookingAccessService } from './booking-access.service';
import { BookingsService } from './bookings.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { WaiverService } from '../waiver/waiver.service';

jest.mock('../booking-class-advisory-lock', () => ({
  acquireBookingClassAdvisoryLock: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../membership-usage/membership-usage-advisory-lock', () => ({
  acquireMembershipUsageAdvisoryLock: jest.fn().mockResolvedValue(undefined),
}));

const STUDIO_ID = 'studio-1';
const CLASS_ID = 'class-1';
const USER_ID = 'user-member';
const STAFF_ID = 'user-staff';
const FUTURE = new Date(Date.now() + 3_600_000);
const PAST = new Date(Date.now() - 3_600_000);

function makeBooking() {
  return { id: 'booking-1', studioId: STUDIO_ID, scheduledClassId: CLASS_ID, userId: USER_ID, status: BookingStatus.CONFIRMED };
}

function makeMembership(role: Role = Role.MEMBER): {
  id: string; userId: string; studioId: string; role: Role; deletedAt: null;
  user: { deletedAt: Date | null };
} {
  return { id: 'mem-1', userId: USER_ID, studioId: STUDIO_ID, role, deletedAt: null, user: { deletedAt: null } };
}

function makeClass(overrides: Partial<{ startsAt: Date; endsAt: Date; status: ClassStatus; capacity: number }> = {}) {
  return {
    id: CLASS_ID,
    studioId: STUDIO_ID,
    classTemplateId: 'tpl-1',
    startsAt: overrides.startsAt ?? FUTURE,
    endsAt: overrides.endsAt ?? new Date(FUTURE.getTime() + 3_600_000),
    status: overrides.status ?? ClassStatus.SCHEDULED,
    capacity: overrides.capacity ?? 20,
  };
}

function makeStudio() {
  return { timezone: 'America/Mexico_City' };
}

function makeTx(overrides: {
  membership?: ReturnType<typeof makeMembership> | null;
  scheduledClass?: ReturnType<typeof makeClass> | null;
  studio?: ReturnType<typeof makeStudio> | null;
  overlapBooking?: object | null;
  overlapCandidates?: object[];
  confirmedCount?: number;
}) {
  return {
    studioMembership: { findFirst: jest.fn().mockResolvedValue('membership' in overrides ? overrides.membership : makeMembership()) },
    scheduledClass: { findFirst: jest.fn().mockResolvedValue('scheduledClass' in overrides ? overrides.scheduledClass : makeClass()) },
    studio: { findUnique: jest.fn().mockResolvedValue('studio' in overrides ? overrides.studio : makeStudio()) },
    booking: {
      findFirst: jest.fn().mockResolvedValue(overrides.overlapBooking ?? null),
      findMany: jest.fn().mockResolvedValue(
        overrides.overlapCandidates ??
          (overrides.overlapBooking ? [overrides.overlapBooking] : []),
      ),
      count: jest.fn().mockResolvedValue(overrides.confirmedCount ?? 0),
      create: jest.fn().mockResolvedValue(makeBooking()),
    },
    classTemplate: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ durationMinutes: 60 }),
    },
  };
}

describe('BookingsService', () => {
  let service: BookingsService;
  let prisma: { $transaction: jest.Mock };
  let bookingAccess: { assertAccess: jest.Mock };
  let waiverService: { assertMemberWaiverAccepted: jest.Mock };
  let waitlistService: { promoteNextAfterSpotOpenedInTx: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();

    bookingAccess = { assertAccess: jest.fn().mockResolvedValue(undefined) };
    waiverService = { assertMemberWaiverAccepted: jest.fn().mockResolvedValue(undefined) };
    waitlistService = { promoteNextAfterSpotOpenedInTx: jest.fn().mockResolvedValue(null) };
    prisma = { $transaction: jest.fn() };

    service = new BookingsService(
      prisma as never,
      waitlistService as unknown as WaitlistService,
      bookingAccess as unknown as BookingAccessService,
      waiverService as unknown as WaiverService,
    );
  });

  function setupTx(overrides: Parameters<typeof makeTx>[0] = {}) {
    const tx = makeTx(overrides);
    prisma.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    return tx;
  }

  // ─── BUG-1 fix: membership-usage advisory lock ─────────────────────────────

  describe('[BUG-1] membership-usage advisory lock serialises concurrent credit checks', () => {
    it('acquires membership-usage lock for MEMBER role', async () => {
      setupTx({ membership: makeMembership(Role.MEMBER) });
      await service.createBooking(STUDIO_ID, CLASS_ID, USER_ID);
      expect(usageLockModule.acquireMembershipUsageAdvisoryLock).toHaveBeenCalledWith(
        expect.anything(),
        STUDIO_ID,
        USER_ID,
      );
    });

    it('acquires membership-usage lock before assertAccess (lock protects credit read)', async () => {
      setupTx({ membership: makeMembership(Role.MEMBER) });
      const lockOrder: string[] = [];
      (usageLockModule.acquireMembershipUsageAdvisoryLock as jest.Mock).mockImplementation(() => {
        lockOrder.push('usageLock');
        return Promise.resolve();
      });
      bookingAccess.assertAccess.mockImplementation(() => {
        lockOrder.push('assertAccess');
        return Promise.resolve();
      });
      await service.createBooking(STUDIO_ID, CLASS_ID, USER_ID);
      const lockIdx = lockOrder.indexOf('usageLock');
      const accessIdx = lockOrder.indexOf('assertAccess');
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(accessIdx).toBeGreaterThan(lockIdx);
    });

    const bypassRoles = [Role.STAFF, Role.INSTRUCTOR, Role.ADMIN, Role.OWNER] as const;
    it.each(bypassRoles)('does NOT acquire membership-usage lock for %s role', async (role) => {
      const userId = `user-${role.toLowerCase()}`;
      const membership = { ...makeMembership(role), userId };
      setupTx({ membership });
      await service.createBooking(STUDIO_ID, CLASS_ID, userId);
      expect(usageLockModule.acquireMembershipUsageAdvisoryLock).not.toHaveBeenCalled();
    });
  });

  // ─── Class status guard ────────────────────────────────────────────────────

  describe('class status guards', () => {
    it('throws ConflictException when class is CANCELLED', async () => {
      setupTx({ scheduledClass: makeClass({ status: ClassStatus.CANCELLED }) });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws ConflictException when class is COMPLETED', async () => {
      setupTx({ scheduledClass: makeClass({ status: ClassStatus.COMPLETED }) });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws ConflictException when class has already started', async () => {
      setupTx({ scheduledClass: makeClass({ startsAt: PAST }) });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('throws ConflictException when class is at full capacity', async () => {
      setupTx({ scheduledClass: makeClass({ capacity: 5 }), confirmedCount: 5 });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  // ─── Membership checks ─────────────────────────────────────────────────────

  describe('membership checks', () => {
    it('throws ForbiddenException when membership does not exist', async () => {
      setupTx({ membership: null });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when user is soft-deleted', async () => {
      setupTx({
        membership: { ...makeMembership(), user: { deletedAt: new Date() } },
      });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('throws NotFoundException when class does not exist', async () => {
      setupTx({ scheduledClass: null });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ─── Duplicate booking ─────────────────────────────────────────────────────

  describe('duplicate booking', () => {
    it('throws ConflictException "Already booked" when P2002 unique violation occurs', async () => {
      const tx = setupTx();
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      tx.booking.create.mockRejectedValue(p2002);
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toMatchObject({
        message: 'Already booked for this class',
      });
    });
  });

  // ─── Overlap check ─────────────────────────────────────────────────────────

  describe('overlap check', () => {
    it('throws ConflictException when member has overlapping confirmed booking', async () => {
      const overlapRow = {
        id: 'overlap-booking',
        scheduledClass: {
          startsAt: FUTURE,
          endsAt: new Date(FUTURE.getTime() + 3_600_000),
          classTemplate: { durationMinutes: 60 },
        },
      };
      setupTx({ overlapCandidates: [overlapRow] });
      await expect(service.createBooking(STUDIO_ID, CLASS_ID, USER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('does NOT throw when overlap candidate fails effective duration check', async () => {
      const pastStart = new Date(Date.now() - 86_400_000);
      const corruptEnd = new Date(pastStart.getTime() + 304 * 86_400_000);
      setupTx({
        overlapCandidates: [
          {
            id: 'stale-booking',
            scheduledClass: {
              startsAt: pastStart,
              endsAt: corruptEnd,
              classTemplate: { durationMinutes: 60 },
            },
          },
        ],
      });
      await service.createBooking(STUDIO_ID, CLASS_ID, USER_ID);
    });

    it('does NOT throw when staff has overlapping booking (bypass)', async () => {
      const tx = setupTx({ membership: makeMembership(Role.STAFF) });
      await service.createBooking(STUDIO_ID, CLASS_ID, STAFF_ID);
      expect(tx.booking.findMany).not.toHaveBeenCalled();
    });
  });

  // ─── Waiver check ──────────────────────────────────────────────────────────

  describe('waiver check', () => {
    it('calls waiverService before transaction', async () => {
      const callOrder: string[] = [];
      waiverService.assertMemberWaiverAccepted.mockImplementation(() => {
        callOrder.push('waiver');
        return Promise.resolve();
      });
      prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
        callOrder.push('tx');
        return fn(makeTx({}));
      });
      await service.createBooking(STUDIO_ID, CLASS_ID, USER_ID);
      expect(callOrder.indexOf('waiver')).toBeLessThan(callOrder.indexOf('tx'));
    });
  });

  // ─── Advisory lock ordering ────────────────────────────────────────────────

  describe('advisory lock ordering', () => {
    it('acquires class lock before membership-usage lock', async () => {
      setupTx({ membership: makeMembership(Role.MEMBER) });
      const lockOrder: string[] = [];
      (bookingLockModule.acquireBookingClassAdvisoryLock as jest.Mock).mockImplementation(() => {
        lockOrder.push('classLock');
        return Promise.resolve();
      });
      (usageLockModule.acquireMembershipUsageAdvisoryLock as jest.Mock).mockImplementation(() => {
        lockOrder.push('usageLock');
        return Promise.resolve();
      });
      await service.createBooking(STUDIO_ID, CLASS_ID, USER_ID);
      expect(lockOrder.indexOf('classLock')).toBeLessThan(lockOrder.indexOf('usageLock'));
    });
  });
});
