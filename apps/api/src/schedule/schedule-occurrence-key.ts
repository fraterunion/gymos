/** Idempotency key for scheduled class slots (generator + manual create). */
export function occurrenceDedupKey(classTemplateId: string, startsAt: Date): string {
  return `${classTemplateId}|${startsAt.toISOString()}`;
}
