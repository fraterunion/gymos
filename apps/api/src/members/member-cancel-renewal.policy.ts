/**
 * Member self-service renewal stop. Stripe's live subscription is the billing
 * authority. Scheduling cancel_at_period_end does not void, refund, or forgive
 * invoices and does not change GymOS entitlement by itself.
 */

/** Stripe statuses that accept cancel_at_period_end. `unpaid` is included because GymOS stores it as PAST_DUE. */
export const PERIOD_END_CANCEL_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);

export type StripeCancelSnapshot = {
  id: string;
  status: string;
  customerId: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
};

export type PeriodEndCancelDecision =
  | { kind: 'schedule' }
  | { kind: 'already_scheduled' }
  | { kind: 'unsupported'; message: string };

export function readStripeCancelSnapshot(sub: {
  id: string;
  status: string;
  customer?: string | { id?: string | null } | null;
  cancel_at_period_end?: boolean | null;
  current_period_end?: number | null;
  items?: { data?: Array<{ current_period_end?: number | null } | null> | null } | null;
}): StripeCancelSnapshot {
  const customer = sub.customer;
  const customerId = typeof customer === 'string' ? customer : customer?.id ?? null;
  const itemEnd = sub.items?.data?.[0]?.current_period_end ?? null;
  const rawEnd = itemEnd ?? sub.current_period_end ?? null;
  return {
    id: sub.id,
    status: sub.status,
    customerId,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    currentPeriodEnd: rawEnd && rawEnd > 0 ? new Date(rawEnd * 1000) : null,
  };
}

export function decidePeriodEndCancel(live: Pick<StripeCancelSnapshot, 'status' | 'cancelAtPeriodEnd'>): PeriodEndCancelDecision {
  if (PERIOD_END_CANCEL_STRIPE_STATUSES.has(live.status)) {
    return live.cancelAtPeriodEnd ? { kind: 'already_scheduled' } : { kind: 'schedule' };
  }
  return { kind: 'unsupported', message: unsupportedStripeStatusMessage(live.status) };
}

export function unsupportedStripeStatusMessage(status: string): string {
  switch (status) {
    case 'paused':
      return 'Esta suscripción está en pausa en Stripe. No se puede programar el fin del periodo desde aquí. Usa Gestionar pago. No se modificó ninguna factura.';
    case 'incomplete':
      return 'El primer pago no se completó, así que no hay un periodo vigente que dejar correr. Usa Gestionar pago. No se modificó ninguna factura.';
    case 'canceled':
    case 'incomplete_expired':
      return 'Stripe ya terminó esta suscripción. No hay renovaciones futuras que detener. No se modificó ninguna factura.';
    default:
      return `Stripe reporta «${status}». No programamos cancelación al final del periodo para ese estado. No se modificó ninguna factura.`;
  }
}

export function localStatusBlocksPeriodEndCancel(status: string): string | null {
  switch (status) {
    case 'CANCELED':
      return 'Esta membresía ya está cancelada en tu cuenta. No hay una renovación que detener.';
    case 'PAUSED':
      return 'Esta membresía está en pausa. No programamos el fin del periodo desde aquí. Usa Gestionar pago.';
    case 'SCHEDULED':
      return 'Esta membresía aún no empieza. No tiene una renovación automática que cancelar.';
    default:
      if (status === 'ACTIVE' || status === 'TRIALING' || status === 'PAST_DUE') return null;
      return `No se puede programar el fin de la renovación para una membresía en estado ${status}.`;
  }
}

export function isUnverifiedStripeError(err: unknown): boolean {
  const value = err as { code?: string; type?: string; message?: string } | null;
  const code = (value?.code ?? '').toLowerCase();
  const type = (value?.type ?? '').toLowerCase();
  const message = (value?.message ?? (err instanceof Error ? err.message : '')).toLowerCase();
  return (
    code === 'etimedout' ||
    code === 'timeout' ||
    code === 'econnreset' ||
    type.includes('timeout') ||
    type === 'stripeconnectionerror' ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset')
  );
}

export const CANCEL_UNVERIFIED_MESSAGE =
  'No pudimos confirmar la cancelación con Stripe. No se registró el cambio. Inténtalo de nuevo.';

export const CANCEL_LOCAL_PERSIST_MESSAGE =
  'Stripe ya detuvo la renovación, pero no pudimos guardarlo en tu cuenta. Desliza para actualizar. No se borró ninguna factura.';
