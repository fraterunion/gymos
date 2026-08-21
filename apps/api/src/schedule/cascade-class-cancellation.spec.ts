import { BookingStatus, CancelSource, WaitlistStatus } from '@prisma/client';
import { cascadeClassCancellationInTx } from './cascade-class-cancellation';

describe('cascadeClassCancellationInTx', () => {
  it('is a no-op when no class ids are provided', async () => {
    const tx = {
      booking: { updateMany: jest.fn() },
      waitlistEntry: { updateMany: jest.fn() },
    };
    const result = await cascadeClassCancellationInTx(tx as never, {
      studioId: 'studio-1',
      scheduledClassIds: [],
    });
    expect(result).toEqual({ cancelledBookingCount: 0, expiredWaitlistCount: 0 });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
  });

  it('cancels CONFIRMED bookings and expires WAITING waitlist entries without deleting attendance', async () => {
    const tx = {
      booking: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      waitlistEntry: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      attendance: { deleteMany: jest.fn() },
    };
    const now = new Date('2026-08-22T12:00:00.000Z');
    const result = await cascadeClassCancellationInTx(tx as never, {
      studioId: 'studio-1',
      scheduledClassIds: ['class-a', 'class-a', 'class-b'],
      now,
    });
    expect(result).toEqual({ cancelledBookingCount: 3, expiredWaitlistCount: 2 });
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: {
        studioId: 'studio-1',
        scheduledClassId: { in: ['class-a', 'class-b'] },
        status: BookingStatus.CONFIRMED,
      },
      data: {
        status: BookingStatus.CANCELLED,
        cancelSource: CancelSource.STUDIO,
        cancelledAt: now,
      },
    });
    expect(tx.waitlistEntry.updateMany).toHaveBeenCalledWith({
      where: {
        studioId: 'studio-1',
        scheduledClassId: { in: ['class-a', 'class-b'] },
        status: WaitlistStatus.WAITING,
      },
      data: { status: WaitlistStatus.EXPIRED },
    });
    expect(tx.attendance.deleteMany).not.toHaveBeenCalled();
  });
});
