/** Build admin class roster URL with optional return navigation context. */
export function classRosterHref(
  scheduledClassId: string,
  options?: {
    returnTo?: "schedule" | "check-in";
    weekStart?: string;
    date?: string;
  },
): string {
  const params = new URLSearchParams();
  if (options?.returnTo) params.set("returnTo", options.returnTo);
  if (options?.weekStart) params.set("weekStart", options.weekStart);
  if (options?.date) params.set("date", options.date);
  const q = params.toString();
  return q ? `/check-in/${scheduledClassId}?${q}` : `/check-in/${scheduledClassId}`;
}

/** Preserve selected calendar week when returning from roster. */
export function scheduleHref(weekStart?: string): string {
  if (!weekStart) return "/schedule";
  const params = new URLSearchParams({ weekStart });
  return `/schedule?${params.toString()}`;
}

/** Preserve selected desk date when returning from roster. */
export function checkInDeskHref(dateKey?: string): string {
  if (!dateKey) return "/check-in";
  const params = new URLSearchParams({ date: dateKey });
  return `/check-in?${params.toString()}`;
}
