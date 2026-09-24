/**
 * Day Pass calendar rules for the app, kept pure so they can be tested without a renderer.
 *
 * Every day here is a canonical studio-local 'YYYY-MM-DD' key. The SERVER decides what
 * "today" is (GET /day-passes/purchase-window); the device clock only formats labels. A key is
 * formatted through a noon-UTC anchor so the printed day can never drift by the device's zone.
 */

import { calendarDayKeyInZone, shiftDayKey, todayKeyInZone } from '@/lib/datetime';
import type { DayPassDto, DayPassPurchaseWindowDto } from '@/lib/api/dayPassesApi';

/** Mirrors the server's DAY_PASS_PURCHASE_HORIZON_DAYS; used only as a fallback when the window call fails. */
export const DAY_PASS_FALLBACK_HORIZON_DAYS = 30;

function anchor(dayKey: string): Date {
  return new Date(`${dayKey}T12:00:00Z`);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Miércoles 30 de septiembre" */
export function formatDayKeyLong(dayKey: string, timeZone: string): string {
  try {
    const d = anchor(dayKey);
    const weekday = new Intl.DateTimeFormat('es-MX', { timeZone, weekday: 'long' }).format(d);
    const day = new Intl.DateTimeFormat('es-MX', { timeZone, day: 'numeric' }).format(d);
    const month = new Intl.DateTimeFormat('es-MX', { timeZone, month: 'long' }).format(d);
    return `${cap(weekday)} ${day} de ${month}`;
  } catch {
    return dayKey;
  }
}

/** "30 de septiembre" */
export function formatDayKeyDayMonth(dayKey: string, timeZone: string): string {
  try {
    const d = anchor(dayKey);
    const day = new Intl.DateTimeFormat('es-MX', { timeZone, day: 'numeric' }).format(d);
    const month = new Intl.DateTimeFormat('es-MX', { timeZone, month: 'long' }).format(d);
    return `${day} de ${month}`;
  } catch {
    return dayKey;
  }
}

/** "mié" */
export function formatDayKeyWeekdayAbbrev(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, weekday: 'short' })
      .format(anchor(dayKey))
      .replace('.', '')
      .toLowerCase();
  } catch {
    return dayKey.slice(5);
  }
}

/** "septiembre" */
export function formatDayKeyMonth(dayKey: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-MX', { timeZone, month: 'long' }).format(anchor(dayKey));
  } catch {
    return dayKey.slice(0, 7);
  }
}

export function dayOfMonth(dayKey: string): number {
  return Number(dayKey.slice(8, 10));
}

/** Relative wording for a day against studio-local today. */
export function relativeDayLabel(dayKey: string, todayKey: string): 'Hoy' | 'Mañana' | 'Próximo' | 'Anterior' {
  if (dayKey === todayKey) return 'Hoy';
  if (dayKey === shiftDayKey(todayKey, 1)) return 'Mañana';
  return dayKey > todayKey ? 'Próximo' : 'Anterior';
}

/** Heading for a pass: "Hoy" / "Mañana" / "Miércoles 30 de septiembre". */
export function formatDayKeyHeading(dayKey: string, todayKey: string, timeZone: string): string {
  const rel = relativeDayLabel(dayKey, todayKey);
  return rel === 'Hoy' || rel === 'Mañana' ? rel : formatDayKeyLong(dayKey, timeZone);
}

/**
 * Relative wording for a PASS. The server's classification (computed on the studio clock at
 * response time) wins when present; the key comparison is only for rows from older API builds.
 */
export function relativeLabelForPass(pass: DayPassDto, todayKey: string, studioTimeZone: string): ReturnType<typeof relativeDayLabel> {
  const key = dayKeyOfPass(pass, studioTimeZone);
  if (pass.relativeDay === 'today') return 'Hoy';
  if (pass.relativeDay === 'past') return 'Anterior';
  if (pass.relativeDay === 'upcoming') return key === shiftDayKey(todayKey, 1) ? 'Mañana' : 'Próximo';
  return relativeDayLabel(key, todayKey);
}

/** Heading for a PASS: "Hoy" / "Mañana" / full date, honouring the server classification. */
export function formatPassHeading(pass: DayPassDto, todayKey: string, studioTimeZone: string): string {
  const rel = relativeLabelForPass(pass, todayKey, studioTimeZone);
  return rel === 'Hoy' || rel === 'Mañana' ? rel : formatDayKeyLong(dayKeyOfPass(pass, studioTimeZone), studioTimeZone);
}

/**
 * Fallback picker window when the server window call is unavailable (older API build or a
 * transient failure): studio-local today from the STUDIO timezone, never the device zone.
 */
export function fallbackPurchaseWindow(studioTimeZone: string, ownedPasses: DayPassDto[], at: Date = new Date()): DayPassPurchaseWindowDto {
  const todayKey = todayKeyInZone(studioTimeZone, at);
  const maxDateKey = shiftDayKey(todayKey, DAY_PASS_FALLBACK_HORIZON_DAYS);
  const ownedDateKeys = ownedPasses
    .filter((p) => p.status === 'ACTIVE')
    .map((p) => dayKeyOfPass(p, studioTimeZone))
    .filter((k) => k >= todayKey && k <= maxDateKey)
    .sort();
  return { timezone: studioTimeZone, todayKey, maxDateKey, horizonDays: DAY_PASS_FALLBACK_HORIZON_DAYS, ownedDateKeys };
}

/** The pass's day: the server's canonical key when present, else derived with the STUDIO zone. */
export function dayKeyOfPass(pass: DayPassDto, studioTimeZone: string): string {
  return pass.validForDateKey ?? calendarDayKeyInZone(pass.validForDate, studioTimeZone);
}

export type DayPassQuickOption = {
  dayKey: string;
  /** "Hoy", "Mañana", or a weekday abbreviation such as "jue". */
  label: string;
  /** Day of month for the chip. */
  sublabel: string;
  owned: boolean;
};

/** Quick chips: today, tomorrow and the next few days of the window. */
export function buildQuickDateOptions(window: DayPassPurchaseWindowDto, count = 7): DayPassQuickOption[] {
  const owned = new Set(window.ownedDateKeys);
  const out: DayPassQuickOption[] = [];
  for (let i = 0; i < count; i++) {
    const dayKey = shiftDayKey(window.todayKey, i);
    if (dayKey > window.maxDateKey) break;
    const rel = relativeDayLabel(dayKey, window.todayKey);
    out.push({
      dayKey,
      label: rel === 'Hoy' || rel === 'Mañana' ? rel : formatDayKeyWeekdayAbbrev(dayKey, window.timezone),
      sublabel: String(dayOfMonth(dayKey)),
      owned: owned.has(dayKey),
    });
  }
  return out;
}

export type CalendarCell = {
  dayKey: string;
  dayOfMonth: number;
  /** Inside [today, maxDateKey]. */
  selectable: boolean;
  owned: boolean;
  isToday: boolean;
};

export type CalendarMonth = {
  /** "septiembre" */
  monthLabel: string;
  /** Rows of 7 (Monday-first); null pads days outside the month. */
  weeks: (CalendarCell | null)[][];
};

/**
 * Month grids covering the purchase window (Monday-first rows). Days outside the window render
 * dimmed and are not selectable; days already owned are marked so they are not sold twice.
 */
export function buildCalendarMonths(window: DayPassPurchaseWindowDto): CalendarMonth[] {
  const owned = new Set(window.ownedDateKeys);
  const months: CalendarMonth[] = [];
  let cursor = `${window.todayKey.slice(0, 7)}-01`;
  const lastMonth = window.maxDateKey.slice(0, 7);
  while (cursor.slice(0, 7) <= lastMonth) {
    const monthKey = cursor.slice(0, 7);
    const cells: CalendarCell[] = [];
    let d = cursor;
    while (d.slice(0, 7) === monthKey) {
      cells.push({
        dayKey: d,
        dayOfMonth: dayOfMonth(d),
        selectable: d >= window.todayKey && d <= window.maxDateKey,
        owned: owned.has(d),
        isToday: d === window.todayKey,
      });
      d = shiftDayKey(d, 1);
    }
    // Monday-first offset: JS getUTCDay() 0=Sun..6=Sat → Monday=0..Sunday=6.
    const first = new Date(`${cursor}T12:00:00Z`).getUTCDay();
    const lead = (first + 6) % 7;
    const padded: (CalendarCell | null)[] = [...Array<null>(lead).fill(null), ...cells];
    while (padded.length % 7 !== 0) padded.push(null);
    const weeks: (CalendarCell | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
    months.push({ monthLabel: formatDayKeyMonth(cursor, window.timezone), weeks });
    cursor = d; // first day of the next month
  }
  return months;
}

export type DayPassSelectionState =
  | { kind: 'ok'; dayKey: string }
  | { kind: 'owned'; dayKey: string }
  | { kind: 'out_of_window'; dayKey: string };

/** The only three things a chosen day can be. Owned or out-of-window never opens Stripe. */
export function evaluateSelection(dayKey: string, window: DayPassPurchaseWindowDto): DayPassSelectionState {
  if (dayKey < window.todayKey || dayKey > window.maxDateKey) return { kind: 'out_of_window', dayKey };
  if (window.ownedDateKeys.includes(dayKey)) return { kind: 'owned', dayKey };
  return { kind: 'ok', dayKey };
}

export type GroupedDayPasses = {
  today: DayPassDto[];
  upcoming: DayPassDto[];
  past: DayPassDto[];
};

/**
 * Today first, then upcoming soonest-first; past newest-first (shown only under "Ver historial").
 * Uses the server's relativeDay when the row has one; otherwise compares keys with todayKey.
 */
export function groupMyDayPasses(passes: DayPassDto[], todayKey: string, studioTimeZone: string): GroupedDayPasses {
  const active = passes.filter((p) => p.status === 'ACTIVE');
  const key = (p: DayPassDto) => dayKeyOfPass(p, studioTimeZone);
  const bucket = (p: DayPassDto): 'today' | 'upcoming' | 'past' => {
    if (p.relativeDay) return p.relativeDay;
    const k = key(p);
    return k === todayKey ? 'today' : k > todayKey ? 'upcoming' : 'past';
  };
  return {
    today: active.filter((p) => bucket(p) === 'today'),
    upcoming: active.filter((p) => bucket(p) === 'upcoming').sort((a, b) => key(a).localeCompare(key(b))),
    past: active.filter((p) => bucket(p) === 'past').sort((a, b) => key(b).localeCompare(key(a))),
  };
}

/** "$250.00 MXN" — locale pinned to es-MX so the review step reads the same on every device. */
export function formatDayPassPrice(priceCents: number, currency: string): string {
  const code = (currency || 'mxn').toUpperCase();
  try {
    const amount = new Intl.NumberFormat('es-MX', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).format(priceCents / 100);
    return `${amount} ${code}`;
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${code}`;
  }
}

export const DAY_PASS_DATE_COPY = {
  pickerTitle: 'Elige la fecha de tu pase',
  pickerBody: 'Tu pase será válido únicamente durante el día seleccionado.',
  reviewTitle: 'Revisa tu pase',
  productName: 'Pase diario',
  continueToPayment: 'Continuar al pago',
  chooseAnotherDate: 'Cambiar fecha',
  ownedTitle: 'Ya tienes un pase diario para esta fecha.',
  sectionTitle: 'Mis pases diarios',
  viewHistory: 'Ver historial',
  hideHistory: 'Ocultar historial',
  noPasses: 'Aún no tienes pases diarios. Compra uno para el día que quieras entrenar.',
  windowUnavailable: 'No pudimos cargar las fechas disponibles. Inténtalo de nuevo.',
} as const;

/** Shown when a day handed over from a class is outside the purchasable window. */
export function requestedDayUnavailableLine(maxDateKey: string, timeZone: string): string {
  return `Esa fecha aún no está disponible. Puedes comprar pases hasta el ${formatDayKeyLong(maxDateKey, timeZone).toLowerCase()}.`;
}

/** "Tu pase del miércoles 30 de septiembre ya está activo." */
export function ownedDateLine(dayKey: string, todayKey: string, timeZone: string): string {
  const rel = relativeDayLabel(dayKey, todayKey);
  if (rel === 'Hoy') return 'Tu pase de hoy ya está activo.';
  if (rel === 'Mañana') return 'Tu pase de mañana ya está activo.';
  return `Tu pase del ${formatDayKeyLong(dayKey, timeZone).toLowerCase()} ya está activo.`;
}

/** After a confirmed payment: "Pase diario activado" + which day. */
export function activatedCopy(dayKey: string, todayKey: string, timeZone: string): { title: string; body: string } {
  const rel = relativeDayLabel(dayKey, todayKey);
  const body =
    rel === 'Hoy'
      ? 'Tu pase es válido hoy.'
      : rel === 'Mañana'
        ? 'Tu pase es válido mañana.'
        : `Tu pase es válido el ${formatDayKeyLong(dayKey, timeZone).toLowerCase()}.`;
  return { title: 'Pase diario activado', body };
}

/** Card step done, server still confirming with Stripe: never a failure. */
export function confirmingCopy(dayKey: string, timeZone: string): string {
  return `Pago recibido. Estamos confirmando tu pase del ${formatDayKeyDayMonth(dayKey, timeZone)}…`;
}
