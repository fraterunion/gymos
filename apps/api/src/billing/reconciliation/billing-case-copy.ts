import type { BillingCaseCategory, BillingCaseSeverity, BillingCaseStatus } from '@prisma/client';

/** Operator-facing Spanish copy for reconciliation cases. Pure; shared by API, alerts and Admin. */

export function categoryLabel(category: BillingCaseCategory): string {
  switch (category) {
    case 'STRIPE_CANCELED_LOCAL_ALIVE':
      return 'Stripe canceló; GymOS la mantiene vigente';
    case 'LOCAL_CANCELED_STRIPE_ALIVE':
      return 'GymOS canceló; Stripe sigue cobrando';
    case 'PAID_WITHOUT_ENTITLEMENT':
      return 'Pago recibido sin acceso';
    case 'STALE_RENEWAL_PERIOD':
      return 'Vigencia desactualizada';
    case 'OVERLAPPING_ENTITLEMENT_CYCLES':
      return 'Vigencias encimadas';
    case 'WEBHOOK_DEAD_LETTER':
      return 'Webhook fallido';
    case 'WEBHOOK_BACKLOG':
      return 'Webhook sin procesar';
    case 'CANCELLATION_REASON_MISMATCH':
      return 'Motivo de cancelación inconsistente';
    case 'OPEN_INVOICE_ON_ENDED_SUBSCRIPTION':
      return 'Factura pendiente de revisión';
    case 'REPEATED_PAYMENT_FAILURES':
      return 'Cobros fallidos repetidos';
    case 'SUBSCRIPTION_IDENTITY_MISMATCH':
      return 'GymOS y Stripe no coinciden';
    case 'PAYMENT_REFUNDED_OR_DISPUTED':
      return 'Pago reembolsado o disputado';
  }
}

export function severityLabel(severity: BillingCaseSeverity): string {
  switch (severity) {
    case 'CRITICAL':
      return 'Crítico';
    case 'HIGH':
      return 'Alto';
    case 'MEDIUM':
      return 'Medio';
    case 'LOW':
      return 'Bajo';
  }
}

export function statusLabel(status: BillingCaseStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Abierto';
    case 'ACKNOWLEDGED':
      return 'En revisión';
    case 'RESOLVED':
      return 'Resuelto';
    case 'DISMISSED':
      return 'Descartado';
  }
}

/** Short sentence for a status change, as the Admin and alerts show it. */
export function statusSentence(status: BillingCaseStatus): string {
  switch (status) {
    case 'OPEN':
      return 'Requiere revisión.';
    case 'ACKNOWLEDGED':
      return 'Este caso ya fue revisado y sigue en seguimiento.';
    case 'RESOLVED':
      return 'Se corrigió la discrepancia.';
    case 'DISMISSED':
      return 'Se descartó: no requiere acción.';
  }
}

export function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export function formatDateEs(value: Date | string | null | undefined, timeZone = 'America/Mexico_City'): string {
  if (!value) return 'fecha desconocida';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'fecha desconocida';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(date);
}

export function formatDateTimeEs(value: Date | string | null | undefined, timeZone = 'America/Mexico_City'): string {
  if (!value) return 'fecha desconocida';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return 'fecha desconocida';
  return new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone }).format(date);
}

/** "Nombre A." — a safe member reference for alerts and lists (no email, no full surname). */
export function safeMemberReference(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const first = (firstName ?? '').trim();
  const last = (lastName ?? '').trim();
  if (!first && !last) return 'miembro';
  return last ? `${first} ${last.slice(0, 1)}.`.trim() : first;
}
