/**
 * Manual class attendance expects `memberId` = Prisma `User.id` (cuid), not
 * `StudioMembership.id` or subscription ids.
 */

/** Prisma cuid / cuid2-style ids used across GymOS (User, StudioMembership, etc.). */
export const GYMOS_CUID_PATTERN = /^c[a-z0-9]{20,}$/i;

export const INVALID_MEMBER_USER_ID_MESSAGE_ES =
  'No se pudo identificar al miembro seleccionado. Actualiza la lista e inténtalo de nuevo.';

export const INVALID_MEMBER_USER_ID_MESSAGE_EN =
  'Could not identify the selected member. Refresh the list and try again.';

export type MemberUserIdSource = {
  /** Explicit User.id when mapped client-side — preferred for attendance payloads. */
  userId?: string | null;
  user?: { id?: string | null } | null;
  /** StudioMembership.id — must never be sent as manual-attendance memberId. */
  membershipId?: string | null;
};

export function isValidGymosUserId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && GYMOS_CUID_PATTERN.test(trimmed);
}

/**
 * Resolves the User.id to send as manual-attendance `memberId`.
 * Never reads `membershipId`.
 */
export function resolveMemberUserId(source: MemberUserIdSource): string | null {
  const explicit = source.userId?.trim();
  if (explicit && isValidGymosUserId(explicit)) {
    return explicit;
  }
  const fromUser = source.user?.id?.trim();
  if (fromUser && isValidGymosUserId(fromUser)) {
    return fromUser;
  }
  return null;
}

export type ManualAttendancePayloadResult =
  | { ok: true; memberId: string }
  | { ok: false; reason: 'missing' | 'invalid' };

export function buildManualAttendancePayload(
  source: MemberUserIdSource,
): ManualAttendancePayloadResult {
  const memberId = resolveMemberUserId(source);
  if (memberId) {
    const membershipId = source.membershipId?.trim();
    const explicitUserId = source.userId?.trim();
    if (
      membershipId &&
      memberId === membershipId &&
      explicitUserId !== memberId
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, memberId };
  }
  const raw = (source.userId ?? source.user?.id ?? '').trim();
  if (raw.length > 0) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: false, reason: 'missing' };
}
