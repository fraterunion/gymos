import type { CreateOfflineSubscriptionInput, OfflineSubscriptionResult } from "@/lib/api/sales";
import type { CashSalePeriodPayload } from "./cashSalePeriod";

/**
 * "Fecha del pago" for Admin cash sales — a REPORTING date only: the studio-local calendar day
 * the cash was received, sent as `paidOn`. It never feeds the membership period
 * (periodStart / periodEnd) and is not the record's creation time. The API keeps today's
 * receipts at the real capture instant, stores past days at studio-local noon and rejects
 * future days itself; this module mirrors those rules so the form fails before submitting.
 *
 * Self-contained for `node --test` (type-only imports).
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD for `at` in the studio time zone. */
export function studioDateKey(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof at === "string" ? new Date(at) : at);
}

export type PaidOnCheck = { ok: true } | { ok: false; message: string };

/** Today and any past real calendar day are valid; empty, malformed, impossible or future days are not. */
export function checkCashPaidOn(paidOn: string, todayKey: string): PaidOnCheck {
  if (!DATE_KEY.test(paidOn)) return { ok: false, message: "Selecciona la fecha del pago." };
  const [y, m, d] = paidOn.split("-").map(Number);
  if (new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) !== paidOn) {
    return { ok: false, message: "La fecha del pago no es válida." };
  }
  if (paidOn > todayKey) return { ok: false, message: "La fecha del pago no puede ser futura." };
  return { ok: true };
}

/**
 * The cash-sale request. The membership period comes ONLY from `period` (the vigencia inputs);
 * `paidOn` is attached alongside and never changes it.
 */
export function buildCashSaleRequest(params: {
  planId: string;
  amountCents: number;
  period: CashSalePeriodPayload;
  paidOn: string;
  todayKey: string;
  notes?: string;
  priceOverrideNote?: string;
}): { ok: true; request: CreateOfflineSubscriptionInput } | { ok: false; message: string } {
  const check = checkCashPaidOn(params.paidOn, params.todayKey);
  if (!check.ok) return check;
  return {
    ok: true,
    request: {
      planId: params.planId,
      amountCents: params.amountCents,
      ...(params.period.omitPeriod
        ? {}
        : { periodStart: params.period.periodStartIso, periodEnd: params.period.periodEndIso }),
      paidOn: params.paidOn,
      paymentMethod: "CASH",
      notes: params.notes?.trim() || undefined,
      priceOverrideNote: params.priceOverrideNote?.trim() || undefined,
    },
  };
}

export type CashReceiptRow = { label: string; dateKey: string | null; value: string };

function formatStudioDate(iso: string, timeZone: string, withTime: boolean): string {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(new Date(iso));
}

/** The four dates a recorded cash sale has, each labelled separately and shown in the studio time zone. */
export function cashReceiptRows(
  result: OfflineSubscriptionResult,
  submittedPaidOn: string,
  timeZone: string,
): CashReceiptRow[] {
  const row = (label: string, iso: string | null, withTime = false): CashReceiptRow =>
    iso
      ? { label, dateKey: studioDateKey(iso, timeZone), value: formatStudioDate(iso, timeZone, withTime) }
      : { label, dateKey: null, value: "—" };
  const paid = result.payment.paidAt
    ? row("Fecha del pago", result.payment.paidAt)
    : { label: "Fecha del pago", dateKey: submittedPaidOn, value: submittedPaidOn };
  return [
    paid,
    row("Inicio de la membresía", result.subscription.currentPeriodStart),
    row("Fin de la membresía", result.subscription.currentPeriodEnd),
    row("Registrado en el sistema", result.payment.createdAt, true),
  ];
}
