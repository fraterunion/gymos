import type { SubStatus } from '@/lib/api/memberProfileApi';
import { getColors } from '@/constants/Theme';

export type MemberOverviewStatusKey =
  | 'active'
  | 'past_due'
  | 'no_membership'
  | 'waiver_pending';

export type MemberOverviewStatus = {
  key: MemberOverviewStatusKey;
  label: string;
  dotColor: string;
  bg: string;
  textColor: string;
};

export function deriveMemberOverviewStatus(input: {
  subscriptionStatus: SubStatus | null;
  waiverRequired: boolean | null;
  waiverAccepted: boolean | null;
}): MemberOverviewStatus {
  const C = getColors();

  if (input.waiverRequired && input.waiverAccepted === false) {
    return {
      key: 'waiver_pending',
      label: 'Carta pendiente',
      dotColor: C.caution,
      bg: 'rgba(251,191,36,0.12)',
      textColor: C.caution,
    };
  }

  if (input.subscriptionStatus === 'PAST_DUE') {
    return {
      key: 'past_due',
      label: 'Pago pendiente',
      dotColor: C.caution,
      bg: 'rgba(251,191,36,0.12)',
      textColor: C.caution,
    };
  }

  if (input.subscriptionStatus === 'ACTIVE' || input.subscriptionStatus === 'TRIALING') {
    return {
      key: 'active',
      label: 'Activo',
      dotColor: C.positive,
      bg: 'rgba(52,211,153,0.12)',
      textColor: C.positive,
    };
  }

  return {
    key: 'no_membership',
    label: 'Sin membresía',
    dotColor: C.textMute,
    bg: 'rgba(255,255,255,0.06)',
    textColor: C.textMute,
  };
}

export function subscriptionSourceLabel(source: string | null | undefined): string | null {
  if (!source) return null;
  switch (source) {
    case 'STRIPE':
      return 'Stripe';
    case 'CASH':
      return 'Efectivo';
    case 'MANUAL':
      return 'Manual';
    default:
      return source;
  }
}

export function formatProfileDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatProfileDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}
