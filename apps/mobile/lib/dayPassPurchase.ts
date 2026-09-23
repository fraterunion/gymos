/**
 * Day Pass purchase presentation rules, kept pure so they can be tested without a renderer.
 *
 * The rule that matters: the client NEVER decides that a pass was bought. PaymentSheet's
 * "completed" only means "the card step finished"; the pass exists when the server, having
 * asked Stripe, reports it ACTIVE. Everything here maps sheet/API outcomes to Spanish copy
 * and to the next action the screen should take.
 */

import type { DayPassStatus } from '@/lib/api/dayPassesApi';

/** Subset of @stripe/stripe-react-native's PaymentSheetError codes this screen reacts to. */
export type PaymentSheetErrorLike = { code?: string | null; message?: string | null } | null | undefined;

export type PaymentSheetOutcome =
  /** Card step finished; the server must now confirm with Stripe. */
  | { kind: 'completed' }
  /** Member closed the sheet on purpose: say nothing, keep the attempt reusable. */
  | { kind: 'canceled' }
  /** Decline / processing error / timeout: show copy, keep the attempt reusable. */
  | { kind: 'failed'; message: string };

export const DAY_PASS_COPY = {
  activated: 'Pase diario activado.',
  confirming: 'Pago recibido. Estamos confirmando tu pase; aparecerá aquí en unos segundos.',
  cardFailed:
    'No se pudo completar el pago. Revisa los datos de tu tarjeta o intenta con otra.',
  timeout: 'La operación tardó demasiado. Revisa tu conexión e inténtalo de nuevo.',
  sheetInitFailed: 'No pudimos abrir el formulario de pago. Inténtalo de nuevo.',
  startFailed: 'No se pudo iniciar la compra del pase diario. Inténtalo de nuevo.',
} as const;

export function resolvePaymentSheetOutcome(error: PaymentSheetErrorLike): PaymentSheetOutcome {
  if (!error) return { kind: 'completed' };
  switch (error.code) {
    case 'Canceled':
      return { kind: 'canceled' };
    case 'Timeout':
      return { kind: 'failed', message: DAY_PASS_COPY.timeout };
    default:
      // Stripe's own message may be English or reveal processor detail; members get one
      // consistent Spanish line. The raw message stays available to logs via the caller.
      return { kind: 'failed', message: DAY_PASS_COPY.cardFailed };
  }
}

export type PostPaymentAction =
  | { kind: 'activated'; message: string }
  | { kind: 'confirming'; message: string };

/**
 * After the card step, the server's answer (from Stripe) decides what to show. Only ACTIVE
 * is a purchased pass; anything else means "wait for confirmation", never "failed", because
 * the money step already finished on the client and the webhook/sync will land.
 */
export function describePostPaymentStatus(status: DayPassStatus | null | undefined): PostPaymentAction {
  return status === 'ACTIVE'
    ? { kind: 'activated', message: DAY_PASS_COPY.activated }
    : { kind: 'confirming', message: DAY_PASS_COPY.confirming };
}

/**
 * The server answers 409 "already owned" when the member holds a purchased pass for the day,
 * including right after it self-healed a payment whose webhook was late. That is good news, not
 * an error: the screen shows it neutrally and reloads the list so the pass appears.
 */
export function isAlreadyOwnedConflict(error: unknown): boolean {
  const e = error as { status?: unknown; message?: unknown } | null;
  return !!e && e.status === 409 && typeof e.message === 'string' && /pase diario activo para esta fecha/i.test(e.message);
}

/**
 * Double-tap guard. React state (`busy`) lags a synchronous second tap, so the screen also
 * keeps a ref that flips the instant a purchase starts.
 */
export function canStartDayPassPurchase(busy: boolean, inFlight: boolean): boolean {
  return !busy && !inFlight;
}
