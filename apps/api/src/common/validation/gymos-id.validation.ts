/**
 * GymOS id validation for API DTOs.
 *
 * Prisma uses cuid/cuid2-style ids (User.id, StudioMembership.id, etc.).
 * Keep this constant API-local — do not import @gymos/utils at runtime:
 * that package resolves to source barrels that Node ESM cannot load in production.
 */
export const GYMOS_CUID_PATTERN = /^c[a-z0-9]{20,}$/i;
