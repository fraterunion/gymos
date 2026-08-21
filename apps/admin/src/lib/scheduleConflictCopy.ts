import type { ScheduleOperationConflict } from "@/lib/api/scheduleOperations";

const DAY_NAMES = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];

/** Spanish presentation for structured schedule conflict codes. */
export function formatScheduleConflict(conflict: ScheduleOperationConflict): string {
  return translateConflictMessage(conflict.message);
}

/** Fallback when only English backend message is available. */
export function translateConflictMessage(message: string): string {
  const m = message.trim();
  const instructorMatch = /^(.+?) already teaches (.+?) at this time\.$/.exec(m);
  if (instructorMatch) {
    return `${instructorMatch[1]} ya tiene una clase asignada en ese horario (${instructorMatch[2]}).`;
  }
  if (m.startsWith("A ") && m.includes(" session already exists at this time.")) {
    return "Ya existe una sesión de esta clase en ese horario.";
  }
  if (m.includes("confirmed booking")) {
    return "La capacidad es menor que las reservaciones confirmadas.";
  }
  return m;
}

export function formatSeriesDayLabel(dayOfWeek: number, startTime: string): string {
  const day = DAY_NAMES[dayOfWeek] ?? "—";
  return `Todos los ${day} · ${startTime}`;
}
