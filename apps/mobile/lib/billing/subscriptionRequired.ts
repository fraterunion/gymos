import { ApiError } from '@/lib/api/errors';

/** Matches booking and waitlist `403` when a MEMBER lacks an active/trialing subscription. */
export function isActiveSubscriptionRequiredError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) {
    return false;
  }
  return /active subscription required/i.test(e.message);
}
