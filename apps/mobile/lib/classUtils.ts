import type { ScheduledClassDto } from '@/lib/types/studio';

export function scheduledClassTitle(scheduledClassId: string, classes: ScheduledClassDto[]): string {
  const c = classes.find((x) => x.id === scheduledClassId);
  return c?.classTemplate?.name?.trim() || 'Scheduled class';
}

export function isClassFullMessage(message: string): boolean {
  return message.toLowerCase().includes('full');
}
