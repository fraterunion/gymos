import { ApiError } from '@/lib/api/errors';
import { fetchPublicSchedule } from '@/lib/api/publicScheduleApi';
import { scheduledClassTitle } from '@/lib/classUtils';
import { buildScheduleQueryRange, formatClassTime } from '@/lib/datetime';
import { resolveStaffScanErrorCopy } from '@/lib/staffScanErrorCopy';
import { userFacingApiMessage } from '@/lib/userFacingApiMessage';

export type StaffScanSuccessDetails = {
  memberName: string;
  className: string;
  classStartTime: string;
  checkedInAt: string;
};

/** Duck-typed like walletPassState — keeps callers free of instanceof-only ApiError checks. */
function isStaffScanApiError(
  error: unknown,
): error is { message: string; status: number; body?: unknown } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { status?: unknown }).status === 'number'
  );
}

/**
 * Front Desk scan / walk-in refusal copy.
 * Membership-expired recognition lives in resolveStaffScanErrorCopy (tested in isolation).
 */
export function staffScanErrorCopy(error: unknown): { title: string; message: string } {
  if (!isStaffScanApiError(error)) {
    return {
      title: 'Error de red',
      message: 'No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.',
    };
  }

  const resolved = resolveStaffScanErrorCopy(error.message, error.status);

  // Enrich generic fallback with member-facing API mapping when we have a real ApiError.
  if (resolved.title === 'Check-in fallido' && error instanceof ApiError) {
    return {
      title: resolved.title,
      message: userFacingApiMessage(error, resolved.message),
    };
  }

  return resolved;
}

export async function resolveStaffScanClassDetails(
  /** Null for a visit with no class (Open Gym); falls back to the same copy as a lookup miss. */
  scheduledClassId: string | null,
  studioSlug: string,
  timeZone: string,
): Promise<{ className: string; classStartTime: string }> {
  if (!scheduledClassId) {
    return { className: 'Clase programada', classStartTime: '—' };
  }
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
      className: 'Clase programada',
      classStartTime: '—',
    };
  }
}
