import type { ClassCategory } from '@prisma/client';

export type ClassAccessSummaryDto = {
  id: string;
  name: string;
  category: ClassCategory | null;
  isOpenGymSlot: boolean;
  accessWindowStart: string | null;
  accessWindowEnd: string | null;
  planCount: number;
  planNames: string[];
  dayPassAllowed: boolean;
  /** true when planCount === 0 and dayPassAllowed === false — nobody can book this class. */
  orphan: boolean;
};
