import type { MemberPaymentDto, MemberProfileDto, MemberSubscriptionDto } from '@/lib/api/memberProfileApi';
import { formatMoneyFromCents } from '@/lib/formatMoney';
import { statusConfig } from '@/lib/membershipStatus';
import { canAccessMemberProfile } from '@/lib/memberProfilePermissions';
import { canAccessSales, canIssueStaffCheckout, canRecordCashSales } from '@/lib/salesPermissions';
import type { SalesSettings } from '@/lib/api/salesApi';
import { formatProfileDate, subscriptionSourceLabel } from '@/lib/memberProfileHelpers';
import { getColors } from '@/constants/Theme';

export function canViewMemberBilling(role: string | null | undefined): boolean {
  return canAccessMemberProfile(role);
}

export function canPerformBillingActions(role: string | null | undefined): boolean {
  return canAccessSales(role);
}

export function canGenerateCheckoutLink(
  role: string | null | undefined,
  settings?: SalesSettings | null,
): boolean {
  return canIssueStaffCheckout(role, settings);
}

export function canRecordCashPayment(
  role: string | null | undefined,
  settings?: SalesSettings | null,
): boolean {
  return canRecordCashSales(role, settings);
}

export function paymentStatusLabel(status: string): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'Completado';
    case 'PENDING':
      return 'Pendiente';
    case 'FAILED':
      return 'Fallido';
    case 'REFUNDED':
      return 'Reembolsado';
    case 'PARTIALLY_REFUNDED':
      return 'Reembolso parcial';
    default:
      return status;
  }
}

export function paymentStatusColors(status: string): { bg: string; text: string } {
  const C = getColors();
  switch (status) {
    case 'SUCCEEDED':
      return { bg: 'rgba(52,211,153,0.12)', text: C.positive };
    case 'PENDING':
      return { bg: 'rgba(251,191,36,0.12)', text: C.caution };
    case 'FAILED':
      return { bg: 'rgba(248,113,113,0.12)', text: C.negative };
    default:
      return { bg: 'rgba(255,255,255,0.06)', text: C.textMute };
  }
}

export function paymentMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  return subscriptionSourceLabel(method) ?? method;
}

export function findActiveSubscriptionWithSource(
  subscriptions: MemberSubscriptionDto[] | null | undefined,
  profile: MemberProfileDto | null,
): MemberSubscriptionDto | null {
  if (!subscriptions?.length) return null;
  const activeId = profile?.activeSubscription?.id;
  if (activeId) {
    const match = subscriptions.find((s) => s.id === activeId);
    if (match) return match;
  }
  return (
    subscriptions.find((s) => s.status === 'ACTIVE' || s.status === 'TRIALING') ?? subscriptions[0]
  );
}

export function deriveRenewalLabel(sub: MemberProfileDto['activeSubscription']): string | null {
  if (!sub) return null;
  if (sub.cancelAtPeriodEnd) return 'No renovará — cancelada al final del periodo';
  if (sub.status === 'PAST_DUE') return null;
  if (sub.status === 'ACTIVE' || sub.status === 'TRIALING') {
    const end = formatProfileDate(sub.currentPeriodEnd);
    return end !== '—' ? `Próxima renovación · ${end}` : null;
  }
  return null;
}

export function findLastPayment(payments: MemberPaymentDto[] | null | undefined): MemberPaymentDto | null {
  if (!payments?.length) return null;
  const succeeded = payments.find((p) => p.status === 'SUCCEEDED');
  return succeeded ?? payments[0] ?? null;
}

export function formatLastPaymentSummary(payment: MemberPaymentDto | null): string | null {
  if (!payment) return null;
  const amount = formatMoneyFromCents(payment.amountCents, payment.currency);
  const when = formatProfileDate(payment.paidAt ?? payment.createdAt);
  const method = paymentMethodLabel(payment.paymentMethod);
  return method ? `${amount} · ${method} · ${when}` : `${amount} · ${when}`;
}

export function billingIntervalLabel(interval: string): string {
  switch (interval) {
    case 'MONTHLY':
      return 'mes';
    case 'YEARLY':
      return 'año';
    case 'WEEKLY':
      return 'semana';
    default:
      return interval.toLowerCase();
  }
}

export function membershipStatusPill(sub: MemberProfileDto['activeSubscription']) {
  if (!sub) {
    const C = getColors();
    return { label: 'Sin membresía', bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
  const cfg = statusConfig(sub.status, sub.cancelAtPeriodEnd);
  return { label: cfg.label, bg: cfg.bg, textColor: cfg.textColor };
}

export function isPastDue(sub: MemberProfileDto['activeSubscription']): boolean {
  return sub?.status === 'PAST_DUE';
}
