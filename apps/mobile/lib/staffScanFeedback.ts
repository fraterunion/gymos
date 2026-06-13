import { ApiError } from '@/lib/api/errors';
import { fetchPublicSchedule } from '@/lib/api/publicScheduleApi';
import { scheduledClassTitle } from '@/lib/classUtils';
import { buildScheduleQueryRange, formatClassTime } from '@/lib/datetime';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

export type StaffScanSuccessDetails = {
  memberName: string;
  className: string;
  classStartTime: string;
  checkedInAt: string;
};

export function staffScanErrorCopy(error: unknown): { title: string; message: string } {
  if (!(error instanceof ApiError)) {
    return {
      title: 'Network error',
      message: 'We could not reach the server. Check your connection and try again.',
    };
  }

  const raw = error.message;
  const m = raw.toLowerCase();

  if (m.includes('already checked in')) {
    return {
      title: 'Already checked in',
      message: 'This member has already checked in for this class.',
    };
  }

  if (
    m.includes('already used') ||
    m.includes('expired') ||
    m.includes('invalid qr') ||
    m.includes('invalid or expired')
  ) {
    return {
      title: 'QR expired or invalid',
      message: 'Ask the member to refresh their QR code from the booking screen and try again.',
    };
  }

  if (m.includes('time window') || m.includes('not available outside')) {
    return {
      title: 'Check-in window not open',
      message: 'Check-in opens 15 minutes before class and closes 30 minutes after it starts.',
    };
  }

  if (error.status === 403) {
    return {
      title: 'Not authorized',
      message: 'Your account does not have permission to check in members for this studio.',
    };
  }

  if (error.status === 401) {
    return {
      title: 'Not authorized',
      message: 'Your session may have expired. Sign in again and retry the scan.',
    };
  }

  if (error.status >= 500) {
    return {
      title: 'Network error',
      message: 'The studio service is temporarily unavailable. Please try again in a moment.',
    };
  }

  return {
    title: 'Check-in failed',
    message: userFacingApiMessage(error, 'We could not complete this check-in. Please try again.'),
  };
}

export async function resolveStaffScanClassDetails(
  scheduledClassId: string,
  studioSlug: string,
  timeZone: string,
): Promise<{ className: string; classStartTime: string }> {
  const { from, to } = buildScheduleQueryRange();
  try {
    const classes = await fetchPublicSchedule(studioSlug, from, to);
    const cls = classes.find((c) => c.id === scheduledClassId);
    return {
      className: scheduledClassTitle(scheduledClassId, classes),
      classStartTime: cls ? formatClassTime(cls.startsAt, timeZone) : '—',
    };
  } catch {
    return {
      className: 'Scheduled class',
      classStartTime: '—',
    };
  }
}
