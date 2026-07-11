import { apiRequest } from "@/lib/api/client";

export type ClassWaitlistEntry = {
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

export async function fetchClassWaitlist(
  studioId: string,
  classId: string,
): Promise<ClassWaitlistEntry[]> {
  return apiRequest<ClassWaitlistEntry[]>(
    `/studios/${studioId}/classes/${classId}/waitlist`,
    { method: "GET" },
  );
}
