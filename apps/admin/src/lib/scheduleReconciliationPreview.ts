import type { ScheduleReconciliationItem } from "@/lib/api/scheduleOperations";

export function formatReconciliationPreviewLine(item: ScheduleReconciliationItem): string {
  const name = item.classTemplateName ?? "Clase";
  const when = [item.dateLabel, item.timeLabel].filter(Boolean).join(" · ");
  const action = item.actionLabel ?? "";
  const detail = item.detail ? ` · ${item.detail}` : "";
  return when ? `${name}\n${when}\n${action}${detail}` : `${name}\n${action}${detail}`;
}

export function visibleReconciliationItems(
  items: ScheduleReconciliationItem[] | undefined,
  limit = 8,
): ScheduleReconciliationItem[] {
  return (items ?? []).slice(0, limit);
}
