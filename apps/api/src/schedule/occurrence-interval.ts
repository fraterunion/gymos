import { BadRequestException } from '@nestjs/common';

export function assertStartsBeforeEnds(startsAt: Date, endsAt: Date): void {
  if (!(startsAt.getTime() < endsAt.getTime())) {
    throw new BadRequestException('startTime must be before endTime');
  }
}

export function endsAtFromDuration(startsAt: Date, durationMinutes: number): Date {
  if (!(durationMinutes > 0)) {
    throw new BadRequestException('durationMinutes must be greater than 0');
  }
  return new Date(startsAt.getTime() + durationMinutes * 60_000);
}
