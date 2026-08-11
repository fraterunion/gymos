import { buildExecutiveInsights } from './executive-insights.utils';

describe('executive-insights.utils', () => {
  it('builds prioritized insights from dashboard signals', () => {
    const insights = buildExecutiveInsights({
      revenueTodayCents: 10000,
      revenueMonthCents: 500000,
      revenueMonthComparisonPercent: 14,
      mrrCents: 1200000,
      failedPaymentsToday: 3,
      failedPaymentsWeek: 5,
      upcoming7DaysCents: 2458000,
      inactiveMembers21Plus: 5,
      topPlanRevenueSharePercent: 73,
      topPlanName: 'Unlimited Strength',
      netMemberGrowthMonth: 4,
      highestOccupancyClass: 'Tuesday Legs Strength',
      highestOccupancyPercent: 96,
    });

    expect(insights.length).toBeGreaterThan(0);
    expect(insights[0]?.id).toBe('failed-today');
    expect(insights.some((i) => i.id === 'revenue-mom')).toBe(true);
    expect(insights.some((i) => i.body.includes('Unlimited Strength'))).toBe(true);
  });
});
