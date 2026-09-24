import type { DayPassDto, DayPassPurchaseWindowDto } from '@/lib/api/dayPassesApi';
import {
  activatedCopy,
  buildCalendarMonths,
  buildQuickDateOptions,
  confirmingCopy,
  dayKeyOfPass,
  evaluateSelection,
  fallbackPurchaseWindow,
  formatDayKeyHeading,
  formatDayKeyLong,
  formatDayPassPrice,
  groupMyDayPasses,
  ownedDateLine,
  relativeDayLabel,
  relativeLabelForPass,
  requestedDayUnavailableLine,
} from '@/lib/dayPassDates';

const TZ = 'America/Mexico_City';
const window: DayPassPurchaseWindowDto = {
  timezone: TZ,
  todayKey: '2026-09-23',
  maxDateKey: '2026-10-23',
  horizonDays: 30,
  ownedDateKeys: ['2026-09-26'],
};

function pass(key: string, status: DayPassDto['status'] = 'ACTIVE', withKey = true): DayPassDto {
  return {
    id: `dp-${key}`,
    validForDate: `${key}T06:00:00.000Z`,
    ...(withKey ? { validForDateKey: key } : {}),
    status,
    priceCents: 25000,
    currency: 'mxn',
    createdAt: '2026-09-01T00:00:00.000Z',
  };
}

describe('date formatting is stable regardless of the device timezone', () => {
  it('formats a day key as a Spanish long date', () => {
    expect(formatDayKeyLong('2026-09-30', TZ)).toBe('Miércoles 30 de septiembre');
    expect(formatDayKeyLong('2026-10-05', TZ)).toBe('Lunes 5 de octubre');
  });

  it('uses Hoy / Mañana for the two nearest days and the full date otherwise', () => {
    expect(relativeDayLabel('2026-09-23', '2026-09-23')).toBe('Hoy');
    expect(relativeDayLabel('2026-09-24', '2026-09-23')).toBe('Mañana');
    expect(relativeDayLabel('2026-09-30', '2026-09-23')).toBe('Próximo');
    expect(relativeDayLabel('2026-09-22', '2026-09-23')).toBe('Anterior');
    expect(formatDayKeyHeading('2026-09-23', '2026-09-23', TZ)).toBe('Hoy');
    expect(formatDayKeyHeading('2026-09-30', '2026-09-23', TZ)).toBe('Miércoles 30 de septiembre');
  });
});

describe('quick options and calendar are driven by the SERVER window', () => {
  it('offers Hoy, Mañana and the following days, marking owned ones', () => {
    const q = buildQuickDateOptions(window, 5);
    expect(q.map((o) => [o.dayKey, o.label, o.owned])).toEqual([
      ['2026-09-23', 'Hoy', false],
      ['2026-09-24', 'Mañana', false],
      ['2026-09-25', 'vie', false],
      ['2026-09-26', 'sáb', true],
      ['2026-09-27', 'dom', false],
    ]);
  });

  it('never offers a day beyond the horizon', () => {
    const short: DayPassPurchaseWindowDto = { ...window, maxDateKey: '2026-09-24' };
    expect(buildQuickDateOptions(short, 7).map((o) => o.dayKey)).toEqual(['2026-09-23', '2026-09-24']);
  });

  it('builds Monday-first month grids covering exactly the window, with only in-window days selectable', () => {
    const months = buildCalendarMonths(window);
    expect(months.map((m) => m.monthLabel)).toEqual(['septiembre', 'octubre']);
    const sept = months[0]!;
    // Sept 1 2026 is a Tuesday → one leading pad on a Monday-first row.
    expect(sept.weeks[0]![0]).toBeNull();
    expect(sept.weeks[0]![1]?.dayKey).toBe('2026-09-01');
    const cells = months.flatMap((m) => m.weeks.flat()).filter((c): c is NonNullable<typeof c> => c !== null);
    const selectable = cells.filter((c) => c.selectable).map((c) => c.dayKey);
    expect(selectable[0]).toBe('2026-09-23');
    expect(selectable[selectable.length - 1]).toBe('2026-10-23');
    expect(selectable).toHaveLength(31);
    expect(cells.find((c) => c.dayKey === '2026-09-22')?.selectable).toBe(false);
    expect(cells.find((c) => c.dayKey === '2026-10-24')?.selectable).toBe(false);
    expect(cells.find((c) => c.dayKey === '2026-09-26')?.owned).toBe(true);
    expect(cells.find((c) => c.dayKey === '2026-09-23')?.isToday).toBe(true);
    for (const m of months) for (const w of m.weeks) expect(w).toHaveLength(7);
  });
});

describe('selection rules: owned or out-of-window never proceeds to Stripe', () => {
  it('classifies the three possible outcomes', () => {
    expect(evaluateSelection('2026-09-24', window)).toEqual({ kind: 'ok', dayKey: '2026-09-24' });
    expect(evaluateSelection('2026-09-26', window)).toEqual({ kind: 'owned', dayKey: '2026-09-26' });
    expect(evaluateSelection('2026-09-22', window)).toEqual({ kind: 'out_of_window', dayKey: '2026-09-22' });
    expect(evaluateSelection('2026-10-24', window)).toEqual({ kind: 'out_of_window', dayKey: '2026-10-24' });
  });

  it('explains an owned day with its date', () => {
    expect(ownedDateLine('2026-09-26', '2026-09-23', TZ)).toBe('Tu pase del sábado 26 de septiembre ya está activo.');
    expect(ownedDateLine('2026-09-23', '2026-09-23', TZ)).toBe('Tu pase de hoy ya está activo.');
  });
});

describe('fallback window (older API / transient failure) still uses the STUDIO clock', () => {
  it('derives today from the studio timezone, not the device, and lists owned in-window days', () => {
    // 05:30Z on Sept 24 is still Sept 23 in Mexico City.
    const at = new Date('2026-09-24T05:30:00.000Z');
    const w = fallbackPurchaseWindow(TZ, [pass('2026-09-25'), pass('2026-09-10'), pass('2026-09-27', 'PENDING')], at);
    expect(w.todayKey).toBe('2026-09-23');
    expect(w.maxDateKey).toBe('2026-10-23');
    expect(w.ownedDateKeys).toEqual(['2026-09-25']);
  });

  it('prefers the server day key and only derives from the instant when it is missing', () => {
    expect(dayKeyOfPass(pass('2026-09-25'), TZ)).toBe('2026-09-25');
    expect(dayKeyOfPass(pass('2026-09-25', 'ACTIVE', false), TZ)).toBe('2026-09-25');
  });
});

describe('grouping for "Mis pases diarios"', () => {
  it('splits today / upcoming (soonest first) / past (most recent first) and ignores non-ACTIVE rows', () => {
    const g = groupMyDayPasses(
      [pass('2026-10-02'), pass('2026-09-23'), pass('2026-09-27'), pass('2026-09-10'), pass('2026-09-15'), pass('2026-09-24', 'PENDING')],
      '2026-09-23',
      TZ,
    );
    expect(g.today.map((p) => p.validForDateKey)).toEqual(['2026-09-23']);
    expect(g.upcoming.map((p) => p.validForDateKey)).toEqual(['2026-09-27', '2026-10-02']);
    expect(g.past.map((p) => p.validForDateKey)).toEqual(['2026-09-15', '2026-09-10']);
  });
});

describe('post-purchase copy always names the purchased day', () => {
  it('activated copy', () => {
    expect(activatedCopy('2026-09-30', '2026-09-23', TZ)).toEqual({ title: 'Pase diario activado', body: 'Tu pase es válido el miércoles 30 de septiembre.' });
    expect(activatedCopy('2026-09-23', '2026-09-23', TZ).body).toBe('Tu pase es válido hoy.');
    expect(activatedCopy('2026-09-24', '2026-09-23', TZ).body).toBe('Tu pase es válido mañana.');
  });

  it('confirming copy', () => {
    expect(confirmingCopy('2026-09-30', TZ)).toBe('Pago recibido. Estamos confirmando tu pase del 30 de septiembre…');
  });
});

describe('review price', () => {
  it('formats the price the same on every device, with the currency code once', () => {
    expect(formatDayPassPrice(25000, 'mxn')).toBe('$250.00 MXN');
    expect(formatDayPassPrice(25000, 'MXN')).toBe('$250.00 MXN');
  });
});

describe('server classification wins over a possibly stale local today', () => {
  it('groups by relativeDay when the row carries it (midnight rollover safe)', () => {
    const staleToday = '2026-09-23';
    const rows: DayPassDto[] = [
      { ...pass('2026-09-24'), relativeDay: 'today' },     // server already rolled to Sept 24
      { ...pass('2026-09-23'), relativeDay: 'past' },
      { ...pass('2026-09-26'), relativeDay: 'upcoming' },
    ];
    const g = groupMyDayPasses(rows, staleToday, TZ);
    expect(g.today.map((p) => p.validForDateKey)).toEqual(['2026-09-24']);
    expect(g.past.map((p) => p.validForDateKey)).toEqual(['2026-09-23']);
    expect(g.upcoming.map((p) => p.validForDateKey)).toEqual(['2026-09-26']);
    expect(relativeLabelForPass(rows[0]!, staleToday, TZ)).toBe('Hoy');
    expect(relativeLabelForPass(rows[1]!, staleToday, TZ)).toBe('Anterior');
    expect(relativeLabelForPass({ ...pass('2026-09-24'), relativeDay: 'upcoming' }, staleToday, TZ)).toBe('Mañana');
  });

  it('falls back to key comparison for rows from an older API build', () => {
    expect(relativeLabelForPass(pass('2026-09-23', 'ACTIVE', false), '2026-09-23', TZ)).toBe('Hoy');
    expect(relativeLabelForPass(pass('2026-10-01', 'ACTIVE', false), '2026-09-23', TZ)).toBe('Próximo');
  });

  it('explains a handed-over day that is beyond the window', () => {
    expect(requestedDayUnavailableLine('2026-10-23', TZ)).toBe('Esa fecha aún no está disponible. Puedes comprar pases hasta el viernes 23 de octubre.');
  });
});
