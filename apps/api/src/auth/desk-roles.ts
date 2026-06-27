import { Role } from '@prisma/client';

/** Roles allowed to scan QR and perform desk check-ins. */
export const DESK_CHECK_IN_ROLES: readonly Role[] = [
  Role.FRONT_DESK,
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
];

/** Roles allowed to read today's schedule and class rosters at the desk. */
export const DESK_SCHEDULE_READ_ROLES: readonly Role[] = [
  Role.FRONT_DESK,
  Role.STAFF,
  Role.INSTRUCTOR,
  Role.ADMIN,
  Role.OWNER,
];
