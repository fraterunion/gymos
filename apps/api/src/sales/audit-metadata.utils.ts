import type { Prisma } from '@prisma/client';

export type AuditFieldChange = { from: unknown; to: unknown };

export function buildAuditChangesRecord(
  changes: Array<{ field: string; oldValue: unknown; newValue: unknown }>,
): Record<string, AuditFieldChange> {
  const record: Record<string, AuditFieldChange> = {};
  for (const change of changes) {
    record[change.field] = { from: change.oldValue, to: change.newValue };
  }
  return record;
}

export function toAuditMetadata(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
