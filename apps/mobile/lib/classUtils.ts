import type { ScheduledClassDto } from '@/lib/types/studio';

export function scheduledClassTitle(scheduledClassId: string, classes: ScheduledClassDto[]): string {
  const c = classes.find((x) => x.id === scheduledClassId);
  return c?.classTemplate?.name?.trim() || 'Clase programada';
}

export function isClassFullMessage(message: string): boolean {
  return message.toLowerCase().includes('full');
}

/** Matches booking/waitlist 409 when the server rejects past-start actions. */
export function isClassAlreadyStartedMessage(message: string): boolean {
  return message.toLowerCase().includes('already started');
}
