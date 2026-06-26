/**
 * FraterUnion Platform Console access — gate on the DB-backed platformRole field.
 * Only users with platformRole === 'PLATFORM_ADMIN' may open /platform.
 */
export function isPlatformAdmin(platformRole: string | null | undefined): boolean {
  return platformRole === "PLATFORM_ADMIN";
}
