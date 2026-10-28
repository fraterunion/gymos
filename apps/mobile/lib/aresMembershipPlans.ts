import { formatMoneyFromCents } from '@/lib/formatMoney';

/** ARES Open Gym hours — member-facing copy. */
export const OPEN_GYM_HOURS_LABEL = 'Open Gym · 10:00 a.m. – 5:00 p.m.';

/** Assumed monthly class load for unlimited plans (marketing price-per-class). */
const UNLIMITED_CLASSES_PER_MONTH = 30;

type PlanPricingInput = {
  name: string;
  priceCents: number;
  currency: string;
  classCredits: number | null;
};

/** Card benefits come from the membership's editable description in GymOS. */
export { resolveAresPlanBenefits } from './membershipBenefits';

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
