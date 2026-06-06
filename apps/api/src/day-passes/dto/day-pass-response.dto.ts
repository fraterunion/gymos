import type { DayPassStatus } from '@prisma/client';

export type DayPassResponseDto = {
  id: string;
  validForDate: Date;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  createdAt: Date;
};
