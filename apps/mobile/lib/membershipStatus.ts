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
    return { label: 'Ending soon', dotColor: C.caution, bg: 'rgba(251,191,36,0.12)', textColor: C.caution };
  }
  switch (status) {
    case 'ACTIVE':
      return { label: 'Active', dotColor: C.positive, bg: 'rgba(52,211,153,0.12)', textColor: C.positive };
    case 'TRIALING':
      return { label: 'Trial', dotColor: '#60A5FA', bg: 'rgba(96,165,250,0.12)', textColor: '#60A5FA' };
    case 'PAST_DUE':
      return { label: 'Past due', dotColor: C.caution, bg: 'rgba(251,191,36,0.12)', textColor: C.caution };
    case 'CANCELED':
      return { label: 'Canceled', dotColor: C.negative, bg: 'rgba(248,113,113,0.12)', textColor: C.negative };
    case 'PAUSED':
      return { label: 'Paused', dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
    default:
      return { label: status, dotColor: C.textMute, bg: 'rgba(255,255,255,0.06)', textColor: C.textMute };
  }
}
