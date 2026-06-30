import type { ScheduledClassDto } from '@/lib/types/studio';

export function spotsRemaining(item: ScheduledClassDto): number | null {
  if (typeof item.bookedCount !== 'number' || item.capacity <= 0) return null;
  return Math.max(0, item.capacity - item.bookedCount);
}

export function isLowSpots(item: ScheduledClassDto): boolean {
  const remaining = spotsRemaining(item);
  return remaining !== null && remaining > 0 && remaining < 5;
}

export function lowSpotsLabel(item: ScheduledClassDto): string | null {
  if (!isLowSpots(item)) return null;
  const remaining = spotsRemaining(item)!;
  return remaining === 1 ? 'Último lugar' : 'Últimos lugares';
}

/** General availability label for schedule cards (e.g. "12 lugares"). */
export function spotsAvailableLabel(item: ScheduledClassDto): string | null {
  const remaining = spotsRemaining(item);
  if (remaining === null) return null;
  if (remaining === 0) return 'Clase llena';
  return remaining === 1 ? '1 lugar disponible' : `${remaining} lugares disponibles`;
}
