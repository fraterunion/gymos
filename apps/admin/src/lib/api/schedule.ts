import { apiRequest } from "@/lib/api/client";

export type ClassTemplateSummary = {
  id: string;
  name: string;
  durationMinutes: number;
  description: string | null;
  defaultCapacity: number;
  color: string | null;
};

export type InstructorSummary = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
};

export type ScheduledClassDto = {
  id: string;
  studioId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: string;
  instructorId: string | null;
  classTemplateId: string;
  classTemplate: ClassTemplateSummary;
  instructor: InstructorSummary | null;
};

export async function fetchStudioSchedule(
  studioId: string,
  from: string,
  to: string,
): Promise<ScheduledClassDto[]> {
  const q = new URLSearchParams({ from, to });
  return apiRequest<ScheduledClassDto[]>(`/studios/${studioId}/schedule?${q.toString()}`, {
    method: "GET",
  });
}
