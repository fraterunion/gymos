import type { ExecutiveInsightDto } from './executive-dashboard.types';

export type ExecutiveInsightInput = {
  revenueTodayCents: number;
  revenueMonthCents: number;
  revenueMonthComparisonPercent: number | null;
  mrrCents: number;
  failedPaymentsToday: number;
  failedPaymentsWeek: number;
  upcoming7DaysCents: number;
  inactiveMembers21Plus: number;
  topPlanRevenueSharePercent: number | null;
  topPlanName: string | null;
  netMemberGrowthMonth: number;
  highestOccupancyClass: string | null;
  highestOccupancyPercent: number | null;
};

export function buildExecutiveInsights(input: ExecutiveInsightInput): ExecutiveInsightDto[] {
  const insights: ExecutiveInsightDto[] = [];

  if (input.revenueMonthComparisonPercent != null) {
    const dir = input.revenueMonthComparisonPercent >= 0 ? 'up' : 'down';
    const abs = Math.abs(input.revenueMonthComparisonPercent);
    insights.push({
      id: 'revenue-mom',
      tone: input.revenueMonthComparisonPercent >= 0 ? 'positive' : 'warning',
      title: dir === 'up' ? 'Ingresos por encima del mes pasado' : 'Ingresos por debajo del mes pasado',
      body:
        dir === 'up'
          ? `Los cobros van ${abs}% arriba vs el mismo punto del mes anterior.`
          : `Los cobros van ${abs}% abajo vs el mismo punto del mes anterior.`,
      facts: {
        revenueMonthComparisonPercent: input.revenueMonthComparisonPercent,
        revenueMonthCents: input.revenueMonthCents,
      },
      priority: 10,
    });
  }

  if (input.failedPaymentsToday > 0) {
    insights.push({
      id: 'failed-today',
      tone: 'critical',
      title: 'Pagos fallidos requieren atención',
      body: `${input.failedPaymentsToday} pago${input.failedPaymentsToday === 1 ? '' : 's'} falló${input.failedPaymentsToday === 1 ? '' : 'ron'} hoy. Revisa tarjetas y contacta a los miembros.`,
      facts: { failedPaymentsToday: input.failedPaymentsToday },
      priority: 1,
    });
  } else if (input.failedPaymentsWeek > 0) {
    insights.push({
      id: 'failed-week',
      tone: 'warning',
      title: 'Fallos de pago recientes',
      body: `${input.failedPaymentsWeek} pago${input.failedPaymentsWeek === 1 ? '' : 's'} fallido${input.failedPaymentsWeek === 1 ? '' : 's'} en los últimos 30 días.`,
      facts: { failedPaymentsWeek: input.failedPaymentsWeek },
      priority: 20,
    });
  }

  if (input.topPlanRevenueSharePercent != null && input.topPlanName) {
    insights.push({
      id: 'plan-mix',
      tone: 'neutral',
      title: 'Concentración por plan',
      body: `${input.topPlanName} representa ${input.topPlanRevenueSharePercent}% de los cobros atribuidos por plan (30d).`,
      facts: {
        topPlanName: input.topPlanName,
        topPlanRevenueSharePercent: input.topPlanRevenueSharePercent,
      },
      priority: 40,
    });
  }

  if (input.upcoming7DaysCents > 0) {
    insights.push({
      id: 'upcoming-7d',
      tone: 'positive',
      title: 'Ingreso esperado próximos 7 días',
      body: `Renovaciones programadas estiman ${Math.round(input.upcoming7DaysCents / 100).toLocaleString('es-MX')} en cobros — sujeto a pagos exitosos.`,
      facts: { upcoming7DaysCents: input.upcoming7DaysCents },
      priority: 15,
    });
  }

  if (input.inactiveMembers21Plus > 0) {
    insights.push({
      id: 'churn-risk',
      tone: 'warning',
      title: 'Riesgo de churn elevado',
      body: `${input.inactiveMembers21Plus} miembro${input.inactiveMembers21Plus === 1 ? '' : 's'} sin visita en más de 3 semanas.`,
      facts: { inactiveMembers21Plus: input.inactiveMembers21Plus },
      priority: 5,
    });
  }

  if (input.highestOccupancyClass && input.highestOccupancyPercent != null && input.highestOccupancyPercent >= 90) {
    insights.push({
      id: 'capacity-hotspot',
      tone: 'positive',
      title: 'Clase con alta demanda',
      body: `${input.highestOccupancyClass} supera ${Math.round(input.highestOccupancyPercent)}% de ocupación. Considera abrir otra sesión.`,
      facts: {
        className: input.highestOccupancyClass,
        occupancyPercent: input.highestOccupancyPercent,
      },
      priority: 50,
    });
  }

  if (input.netMemberGrowthMonth !== 0) {
    insights.push({
      id: 'net-growth',
      tone: input.netMemberGrowthMonth > 0 ? 'positive' : 'warning',
      title: input.netMemberGrowthMonth > 0 ? 'Base de miembros en crecimiento' : 'Base de miembros en contracción',
      body:
        input.netMemberGrowthMonth > 0
          ? `Crecimiento neto (30d): +${input.netMemberGrowthMonth} miembros.`
          : `Cambio neto (30d): ${input.netMemberGrowthMonth} miembros.`,
      facts: { netMemberGrowthMonth: input.netMemberGrowthMonth },
      priority: 30,
    });
  }

  return insights.sort((a, b) => a.priority - b.priority).slice(0, 8);
}

export function relativeTimeLabel(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} d`;
  return new Intl.DateTimeFormat('es-MX', { month: 'short', day: 'numeric' }).format(new Date(iso));
}

export function categorizePlan(planName: string): string {
  const n = planName.toLowerCase();
  if (n.includes('unlimited') || n.includes('ilimit')) return 'Unlimited';
  if (n.includes('flex') || n.includes('8') || n.includes('12')) return 'Flex';
  if (n.includes('trial') || n.includes('prueba')) return 'Trial';
  return 'Other';
}
