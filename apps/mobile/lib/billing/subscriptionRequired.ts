import { ApiError } from '@/lib/api/errors';

/** Matches booking and waitlist `403` when a MEMBER lacks an entitled membership. */
export function isActiveSubscriptionRequiredError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) {
    return false;
  }
  return /MEMBERSHIP_EXPIRED|membresía no está vigente|active membership|active subscription|membresía o pase de día|membresía activa/i.test(
    e.message,
  );
}
