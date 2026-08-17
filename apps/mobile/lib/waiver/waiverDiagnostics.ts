/**
 * Structured diagnostic logging for the waiver/onboarding flow.
 *
 * Does NOT log: tokens, signatures, passwords, or sensitive personal data.
 * All logs are structured JSON written to the console so they are visible
 * in production crash-reporting tools and remote logging aggregators.
 *
 * Server-side observability: the API logs a structured `registration_complete`
 * event with userId, studioId, waiverAccepted, and waiverDocumentId.
 */

type WaiverLoadFailedContext = {
  studioId: string;
  studioSlug: string;
  errorName: string;
  errorMessage: string;
};

type WaiverInvariantViolationContext = {
  studioId: string;
  studioSlug: string;
  waiverStatusRequired: boolean;
  waiverStatusAccepted: boolean;
  publicWaiverNull: boolean;
};

type RegisterWaiverLoadContext = {
  studioSlug: string;
  errorName: string;
  errorMessage: string;
};

export function logWaiverLoadFailed(ctx: WaiverLoadFailedContext): void {
  console.warn(
    JSON.stringify({
      event: 'onboarding_waiver_load_failed',
      ...ctx,
    }),
  );
}

/**
 * Logged when the API returns status.required=true + accepted=false
 * but publicWaiver=null simultaneously.
 * This is the "impossible blocked state" bug from the incident investigation.
 * If this ever fires in production, it means the two API endpoints returned
 * inconsistent data — worth investigating the DB state and timing.
 */
export function logWaiverInvariantViolation(ctx: WaiverInvariantViolationContext): void {
  console.error(
    JSON.stringify({
      event: 'onboarding_waiver_state_invariant_violation',
      ...ctx,
    }),
  );
}

export function logRegisterWaiverLoadFailed(ctx: RegisterWaiverLoadContext): void {
  console.warn(
    JSON.stringify({
      event: 'register_waiver_load_failed',
      ...ctx,
    }),
  );
}
