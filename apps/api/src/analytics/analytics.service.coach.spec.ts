import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

const AS_OF = new Date('2026-07-10T14:00:00.000Z');
const STUDIO_A = 'studio-a';
const DAYS = 30;

function sql(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

describe('AnalyticsService coach class count', () => {
  let service: AnalyticsService;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(AS_OF);

    queryRaw = jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const q = sql(strings);
      if (q.includes('COUNT(DISTINCT sc.id)') && q.includes('class_count')) {
        return Promise.resolve([
          {
            id: 'coach-1',
            first_name: 'Coco',
            last_name: 'Coach',
            class_count: 8n,
          },
        ]);
      }
      if (q.includes('no_show')) {
        return Promise.resolve([{ no_show: 0n, total: 0n }]);
      }
      if (q.includes('booking_count') && q.includes('class_templates')) {
        return Promise.resolve([]);
      }
      if (q.includes('avg_fill') || q.includes('occupancy')) {
        return Promise.resolve([{ avg_fill: null, occupancy: null }]);
      }
      return Promise.resolve([]);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        {
          provide: PrismaService,
          useValue: {
            studioMembership: { count: jest.fn().mockResolvedValue(0) },
            attendance: { count: jest.fn().mockResolvedValue(0) },
            scheduledClass: { count: jest.fn().mockResolvedValue(0) },
            waitlistEntry: { count: jest.fn().mockResolvedValue(0) },
            booking: { count: jest.fn().mockResolvedValue(0) },
            $queryRaw: queryRaw,
          },
        },
      ],
    }).compile();

    service = module.get(AnalyticsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses COUNT(DISTINCT sc.id) with upper bound and canceled exclusion', async () => {
    await service.getOverview(STUDIO_A, DAYS);

    const coachCall = queryRaw.mock.calls.find((c) =>
      sql(c[0]).includes('COUNT(DISTINCT sc.id)'),
    );
    const q = sql(coachCall![0]);
    expect(q).toContain("status NOT IN ('CANCELLED')");
    expect(q).toContain('starts_at <=');
    expect(q).toContain('starts_at >=');
  });

  it('returns coach count for selected period days', async () => {
    const result = await service.getOverview(STUDIO_A, DAYS);
    expect(result.mostActiveCoach?.classCount).toBe(8);
    expect(result.periodDays).toBe(DAYS);
  });

  /**
   * ARES production audit (Jul 2026): ~29–31 classes per coach in 30 days is valid.
   * The official schedule runs ~36 classes/week; coach metrics count DISTINCT
   * scheduled_class.id — not member bookings — so App Review exclusions do not apply.
   */
  it('does not filter coach metrics by exclude_from_analytics', async () => {
    await service.getOverview(STUDIO_A, DAYS);

    const coachCall = queryRaw.mock.calls.find((c) =>
      sql(c[0]).includes('COUNT(DISTINCT sc.id)'),
    );
    const q = sql(coachCall![0]);
    expect(q).not.toContain('exclude_from_analytics');
  });
});
