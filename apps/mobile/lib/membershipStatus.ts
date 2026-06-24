import { getColors } from '@/constants/Theme';

export type MembershipStatusCfg = {
  label: string;
  dotColor: string;
  bg: string;
  textColor: string;
};

/** Maps subscription status → label + colors (shared by Membership and Profile tabs). */
export function statusConfig(status: string, cancelAtPeriodEnd: boolean): MembershipStatusCfg {
  const C = getColors();
  if (status === 'ACTIVE' && cancelAtPeriodEnd) {
    return { label: 'Termina pronto', dotColor: C.caution, bg: 'rgba(251,191,36,0.12)', textColor: C.caution };
  }
  switch (status) {
    case 'ACTIVE':
      return { label: 'Activa', dotColor: C.positive, bg: 'rgba(52,211,153,0.12)', textColor: C.positive };
    case 'TRIALING':
      return { label: 'Prueba', dotColor: '#FFFFFF', bg: 'rgba(255,255,255,0.12)', textColor: '#FFFFFF' };
    case 'PAST_DUE':
      return { label: 'Pago pendiente', dotColor: C.caution, bg: 'rgba(251,191,36,0.12)', textColor: C.caution };
    case 'CANCELED':
      return { label: 'Cancelada', dotColor: C.negative, bg: 'rgba(248,113,113,0.12)', textColor: C.negative };
    case 'PAUSED':
      return { label: 'Pausada', dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
    default:
      return { label: status, dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
}
