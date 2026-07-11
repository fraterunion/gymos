import { apiRequest } from '@/lib/api/client';

export type ClassWaitlistEntryDto = {
  id: string;
  studioId: string;
  scheduledClassId: string;
  userId: string;
  status: string;
  position: number;
  queueRank: number | null;
  createdAt: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  };
};

/** Existing staff waitlist endpoint — same as Admin desk. */
export async function fetchClassWaitlist(
  studioId: string,
  classId: string,
): Promise<ClassWaitlistEntryDto[]> {
  return apiRequest<ClassWaitlistEntryDto[]>(
    `/studios/${studioId}/classes/${classId}/waitlist`,
    { method: 'GET' },
  );
}
