import {
  calendarDayKeyInZone,
  filterOperationalScheduleInWeek,
  isOperationalScheduleClass,
  operationalScheduleActiveIds,
  reconcileOperationalScheduleIds,
  studioLocalDateKeyToUtcAnchor,
  studioWeekQueryRangeIso,
  weekBoundsInZone,
} from '@gymos/utils';

const ARES_TZ = 'America/Mexico_City';

type Row = {
  id: string;
  studioId: string;
  startsAt: string;
  status: string;
  classTemplate?: { deletedAt?: string | null; name?: string };
  instructorId?: string | null;
  bookedCount?: number;
  capacity?: number;
};

function row(overrides: Partial<Row> & Pick<Row, 'id' | 'startsAt'>): Row {
  return {
    studioId: 'studio-ares',
    status: 'SCHEDULED',
    classTemplate: { name: 'HIIT' },
    instructorId: 'inst-1',
    bookedCount: 3,
    capacity: 12,
    ...overrides,
  };
}

describe('operational schedule visibility', () => {
  it('excludes cancelled class', () => {
    expect(
      isOperationalScheduleClass(
        row({ id: 'c1', startsAt: '2030-06-02T15:00:00.000Z', status: 'CANCELLED' }),
      ),
    ).toBe(false);
  });

  it('excludes soft-deleted template class', () => {
    expect(
      isOperationalScheduleClass(
        row({
          id: 'd1',
          startsAt: '2030-06-02T15:00:00.000Z',
          classTemplate: { deletedAt: '2030-01-01T00:00:00.000Z', name: 'Gone' },
        }),
      ),
    ).toBe(false);
  });

  it('includes active scheduled class', () => {
    expect(isOperationalScheduleClass(row({ id: 'a1', startsAt: '2030-06-02T15:00:00.000Z' }))).toBe(
      true,
    );
  });

  it('excludes cross-studio class when studioId is provided', () => {
    const startKey = '2030-06-03';
    const endKey = '2030-06-09';
    const rows = [
      row({ id: 'home', startsAt: '2030-06-04T15:00:00.000Z', studioId: 'studio-ares' }),
      row({ id: 'other', startsAt: '2030-06-04T16:00:00.000Z', studioId: 'studio-b' }),
    ];
    const ids = operationalScheduleActiveIds(rows, startKey, endKey, ARES_TZ, 'studio-ares');
    expect(ids).toEqual(['home']);
  });
});

describe('studio timezone week boundaries', () => {
  it('uses Monday-start week in America/Mexico_City', () => {
    const at = new Date('2030-06-05T18:00:00.000Z');
    const bounds = weekBoundsInZone(ARES_TZ, 0, at);
    expect(bounds.startKey).toBe('2030-06-03');
    expect(bounds.endKey).toBe('2030-06-09');
  });

  it('maps UTC timestamp near midnight to correct local day', () => {
    const iso = '2030-06-03T05:30:00.000Z';
    expect(calendarDayKeyInZone(iso, ARES_TZ)).toBe('2030-06-02');
    const late = '2030-06-03T06:30:00.000Z';
    expect(calendarDayKeyInZone(late, ARES_TZ)).toBe('2030-06-03');
  });

  it('builds studio-local query range for week overlap', () => {
    const range = studioWeekQueryRangeIso('2030-06-03', '2030-06-09', ARES_TZ);
    expect(range.from).toBe(studioLocalDateKeyToUtcAnchor('2030-06-03', ARES_TZ).toISOString());
    expect(range.to).toBe(studioLocalDateKeyToUtcAnchor('2030-06-10', ARES_TZ).toISOString());
  });
});

describe('admin/mobile reconciliation', () => {
  it('returns the same active IDs for identical inputs', () => {
    const startKey = '2030-06-03';
    const endKey = '2030-06-09';
    const rows = [
      row({ id: 'active', startsAt: '2030-06-04T15:00:00.000Z' }),
      row({ id: 'cancelled', startsAt: '2030-06-04T16:00:00.000Z', status: 'CANCELLED' }),
      row({ id: 'next-week', startsAt: '2030-06-11T15:00:00.000Z' }),
    ];

    const adminIds = operationalScheduleActiveIds(rows, startKey, endKey, ARES_TZ, 'studio-ares');
    const mobileIds = filterOperationalScheduleInWeek(
      rows,
      startKey,
      endKey,
      ARES_TZ,
      'studio-ares',
    ).map((r) => r.id);

    expect(adminIds).toEqual(['active']);
    expect(mobileIds).toEqual(['active']);
    expect(reconcileOperationalScheduleIds(adminIds, mobileIds)).toEqual({
      match: true,
      onlyInAdmin: [],
      onlyInMobile: [],
    });
  });
});
