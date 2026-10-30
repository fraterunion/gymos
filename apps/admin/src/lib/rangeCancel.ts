/** Presentation + input rules for "Cancelar clases por rango de fechas" (mirrors the API limits). */

export const RANGE_CANCEL_MAX_DAYS = 184;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const utcMs = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
};

export function validateRangeDates(fromDate: string, toDate: string): string | null {
  if (!DATE_KEY.test(fromDate) || !DATE_KEY.test(toDate)) return "Selecciona la fecha inicial y la final.";
  for (const key of [fromDate, toDate]) {
    if (new Date(utcMs(key)).toISOString().slice(0, 10) !== key) return `Fecha inválida: ${key}.`;
  }
  if (toDate < fromDate) return "La fecha final debe ser igual o posterior a la inicial.";
  const days = Math.round((utcMs(toDate) - utcMs(fromDate)) / 86_400_000) + 1;
  if (days > RANGE_CANCEL_MAX_DAYS) return `El rango no puede exceder ${RANGE_CANCEL_MAX_DAYS} días.`;
  return null;
}

/** Monday (studio-local date key) of the calendar week that contains `dateKey`. */
export function weekStartKey(dateKey: string): string {
  const ms = utcMs(dateKey);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  return new Date(ms - dow * 86_400_000).toISOString().slice(0, 10);
}

/** Groups preview rows by calendar week, preserving chronological order. */
export function groupByWeek<T extends { localDate: string }>(rows: T[]): Array<{ weekStart: string; rows: T[] }> {
  const groups: Array<{ weekStart: string; rows: T[] }> = [];
  for (const row of rows) {
    const key = weekStartKey(row.localDate);
    const last = groups[groups.length - 1];
    if (last && last.weekStart === key) last.rows.push(row);
    else groups.push({ weekStart: key, rows: [row] });
  }
  return groups;
}

export const PROTECTED_REASON_LABEL: Record<"STARTED" | "ATTENDED", string> = {
  STARTED: "ya comenzó o terminó",
  ATTENDED: "tiene check-in anticipado",
};

export function rangeCancelConfirmText(totals: { classes: number; bookings: number; waitlist: number }): string {
  const classes = totals.classes === 1 ? "1 clase" : `${totals.classes} clases`;
  return `Entiendo que se cancelarán ${classes}, ${totals.bookings} reservas y ${totals.waitlist} lugares en lista de espera.`;
}
