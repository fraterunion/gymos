import { formatMoneyFromCents } from '@/lib/formatMoney';

/** ARES Open Gym hours — member-facing copy. */
export const OPEN_GYM_HOURS_LABEL = 'Open Gym · 11:00 a.m. – 5:00 p.m.';

/** Assumed monthly class load for unlimited plans (marketing price-per-class). */
const UNLIMITED_CLASSES_PER_MONTH = 30;

type PlanPricingInput = {
  name: string;
  priceCents: number;
  currency: string;
  classCredits: number | null;
};

/** Vertical benefit bullets for ARES membership cards. */
export function resolveAresPlanBenefits(planName: string): string[] {
  const lower = planName.toLowerCase();

  if (lower.includes('elite')) {
    return [
      'Clases ilimitadas',
      'Sesiones Hyrox incluidas',
      OPEN_GYM_HOURS_LABEL,
      'Tina de hielo y eventos',
      'Programa de running',
      'Guest passes ilimitados',
    ];
  }
  if (lower.includes('hyrox') && !lower.includes('elite')) {
    return [
      '3 sesiones Hyrox por semana',
      'Plan de carrera semanal',
      'Running club',
      OPEN_GYM_HOURS_LABEL,
      'Tina de hielo',
      'No incluye clases regulares',
    ];
  }
  if (lower.includes('full') || lower.includes('unlimited') || lower.includes('all access')) {
    return [
      'Clases ilimitadas',
      OPEN_GYM_HOURS_LABEL,
      '5 guest passes al mes',
      'Tina de hielo',
      'Eventos sin restricción de horario',
    ];
  }
  if (lower.includes('basic') || lower.includes('starter') || lower.includes('essential')) {
    return [
      '12 clases al mes',
      OPEN_GYM_HOURS_LABEL,
      '3 guest passes',
      'Créditos no acumulables',
    ];
  }

  return [];
}

/** Marketing price-per-class overrides (cents) for known ARES plans. */
const PER_CLASS_OVERRIDES_CENTS: Record<string, number> = {
  'full access': 6500,
  'basic access': 10900,
};

export function resolveAresPricePerClassLabel(plan: PlanPricingInput): string | null {
  const lower = plan.name.toLowerCase();
  let perClassCents = PER_CLASS_OVERRIDES_CENTS[lower] ?? null;

  if (perClassCents == null && plan.classCredits != null && plan.classCredits > 0) {
    perClassCents = Math.round(plan.priceCents / plan.classCredits);
  } else if (
    perClassCents == null &&
    (lower.includes('full') || lower.includes('unlimited') || lower.includes('all access'))
  ) {
    perClassCents = Math.round(plan.priceCents / UNLIMITED_CLASSES_PER_MONTH);
  }

  if (perClassCents == null || perClassCents <= 0) return null;
  return `${formatMoneyFromCents(perClassCents, plan.currency)} por clase`;
}
