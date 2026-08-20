export const DAY_MS = 86_400_000;

export type FixedEntitlementCycle = {
  startsAt: Date;
  endsAt: Date;
  creditLimit: number | null;
};

/**
 * Converts one paid Stripe service period into one immutable GymOS entitlement cycle.
 * The provider period must exactly match the configured fixed duration. A late webhook
 * may fill a gap, but it may never overlap a previously granted cycle.
 */
export function buildPaidFixedEntitlementCycle(input: {
  periodStart: Date;
  periodEnd: Date;
  entitlementDays: number;
  creditLimit: number | null;
  previousCycleEnd?: Date | null;
}): FixedEntitlementCycle {
  const expectedMs = input.entitlementDays * DAY_MS;
  const actualMs = input.periodEnd.getTime() - input.periodStart.getTime();
  if (input.entitlementDays <= 0 || Math.abs(actualMs - expectedMs) > 1000) {
    throw new Error(`Provider period must equal ${input.entitlementDays} entitlement days`);
  }
  if (input.previousCycleEnd && input.periodStart < input.previousCycleEnd) {
    throw new Error('Paid entitlement cycle overlaps an existing cycle');
  }
  return {
    startsAt: new Date(input.periodStart),
    endsAt: new Date(input.periodEnd),
    creditLimit: input.creditLimit,
  };
}

export function cycleContains(cycle: FixedEntitlementCycle, at: Date): boolean {
  return at >= cycle.startsAt && at < cycle.endsAt;
}
