/**
 * Member-facing bullet copy is owned by the membershipPlan.description field.
 * Each non-blank line becomes a bullet; leading conventional bullet markers
 * are stripped so an admin can paste formatted lists without double bullets.
 *
 * No plan-name fallback: deleting all copy in admin must remove the bullets.
 */
export function resolveAresPlanBenefits(plan: { description?: string | null }): string[] {
  const description = plan.description?.trim();
  if (!description) return [];
  return description
    .split(/\r?\n|•\s*(?=\S)|\s\+\s/g)
    .map((line) => line.trim().replace(/^(?:[-*•·]\s*|\d+[.)]\s*)/, '').trim())
    .filter((line) => line.length > 0);
}
