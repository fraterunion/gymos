/** Semantic palette for ARES admin analytics charts (Proposal 2 / white canvas). */

export const CHART_COLORS = {
  revenue: '#10b981',
  stripe: '#6366f1',
  cash: '#f59e0b',
  other: '#94a3b8',
  unattributed: '#94a3b8',
  membership: '#3b82f6',
  attendance: '#14b8a6',
  bookings: '#8b5cf6',
  retention: '#818cf8',
  warning: '#f59e0b',
  negative: '#f43f5e',
  neutral: '#a1a1aa',
} as const;

export const CHART_GRID = '#f4f4f5';
export const CHART_AXIS = '#a1a1aa';

export const CHART_TOOLTIP_STYLE = {
  background: '#ffffff',
  border: '1px solid #e4e4e7',
  borderRadius: 10,
  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
  fontSize: 12,
  color: '#18181b',
  padding: '8px 12px',
} as const;

/** Distinct bar colors for membership plan breakdown (max 6 + unattributed). */
export const PLAN_BAR_COLORS = [
  '#6366f1',
  '#10b981',
  '#3b82f6',
  '#8b5cf6',
  '#14b8a6',
  '#f59e0b',
] as const;

export function planBarColor(index: number, isUnattributed = false): string {
  if (isUnattributed) return CHART_COLORS.unattributed;
  return PLAN_BAR_COLORS[index % PLAN_BAR_COLORS.length] ?? CHART_COLORS.neutral;
}

export function stripeVsCashColor(method: string): string {
  if (method === 'stripe') return CHART_COLORS.stripe;
  if (method === 'cash') return CHART_COLORS.cash;
  return CHART_COLORS.other;
}

export function stripeVsCashLabel(method: string): string {
  if (method === 'stripe') return 'Stripe';
  if (method === 'cash') return 'Efectivo';
  return 'Otros';
}
