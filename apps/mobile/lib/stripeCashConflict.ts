export const STRIPE_RENEWABLE_CONFLICT_CODE = 'STRIPE_RENEWABLE_CONFLICT';

export type StripeResolution = 'cancel_immediately' | 'cancel_at_period_end';

export type StripeRenewableConflict = {
  localSubscriptionId: string;
  stripeSubscriptionId: string;
  planId: string;
  planName: string;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingCashTransitionId: string | null;
  allowedResolutions: StripeResolution[];
};

type ApiErrorShape = { message: string; status: number; body?: unknown };

function isApiErrorShape(e: unknown): e is ApiErrorShape {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof (e as ApiErrorShape).status === 'number' &&
    'message' in e
  );
}

function readConflictBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as Record<string, unknown>;
  if (root.code === STRIPE_RENEWABLE_CONFLICT_CODE) return root;
  const nested = root.message;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    if (n.code === STRIPE_RENEWABLE_CONFLICT_CODE) return n;
  }
  return null;
}

export function parseStripeRenewableConflict(error: unknown): StripeRenewableConflict | null {
  if (!isApiErrorShape(error) || error.status !== 409) return null;
  const payload = readConflictBody(error.body);
  if (!payload) return null;
  const conflict = payload.stripeConflict;
  if (!conflict || typeof conflict !== 'object') return null;
  const c = conflict as Record<string, unknown>;
  if (typeof c.planName !== 'string' || typeof c.localSubscriptionId !== 'string') return null;
  const allowed = Array.isArray(c.allowedResolutions)
    ? (c.allowedResolutions.filter(
        (r): r is StripeResolution =>
          r === 'cancel_immediately' || r === 'cancel_at_period_end',
      ) as StripeResolution[])
    : [];
  return {
    localSubscriptionId: c.localSubscriptionId,
    stripeSubscriptionId: typeof c.stripeSubscriptionId === 'string' ? c.stripeSubscriptionId : '',
    planId: typeof c.planId === 'string' ? c.planId : '',
    planName: c.planName,
    status: typeof c.status === 'string' ? c.status : '',
    currentPeriodStart:
      typeof c.currentPeriodStart === 'string' ? c.currentPeriodStart : null,
    currentPeriodEnd: typeof c.currentPeriodEnd === 'string' ? c.currentPeriodEnd : null,
    cancelAtPeriodEnd: Boolean(c.cancelAtPeriodEnd),
    pendingCashTransitionId:
      typeof c.pendingCashTransitionId === 'string' ? c.pendingCashTransitionId : null,
    allowedResolutions: allowed,
  };
}

/** e.g. "30 de agosto" in es-MX */
export function formatPaidThroughDate(iso: string | null, timeZone: string): string {
  if (!iso) return 'el final del periodo actual';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'el final del periodo actual';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(d);
}
