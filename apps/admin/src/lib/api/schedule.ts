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
  bookedCount?: number;
  waitlistCount?: number;
  checkedInCount?: number;
  /** Studio booking rule — authoritative for desk check-in UI gating. */
  checkInWindowMinutes?: number;
};

export async function fetchScheduledClassById(
  studioId: string,
  scheduledClassId: string,
): Promise<ScheduledClassDto> {
  return apiRequest<ScheduledClassDto>(
    `/studios/${studioId}/schedule/${scheduledClassId}`,
    { method: "GET" },
  );
}

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

export async function createScheduledClass(
  studioId: string,
  input: {
    templateId: string;
    startTime: string;
    endTime: string;
    capacity?: number;
    instructorId?: string | null;
  },
): Promise<unknown> {
  return apiRequest<unknown>(`/studios/${studioId}/schedule`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateScheduledClass(
  studioId: string,
  scheduledClassId: string,
  input: {
    startTime?: string;
    endTime?: string;
    capacity?: number;
    instructorId?: string | null;
  },
): Promise<unknown> {
  return apiRequest<unknown>(`/studios/${studioId}/schedule/${scheduledClassId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function cancelScheduledClass(
  studioId: string,
  scheduledClassId: string,
  cancelReason?: string,
): Promise<void> {
  await apiRequest<void>(`/studios/${studioId}/schedule/${scheduledClassId}`, {
    method: "DELETE",
    body: cancelReason ? JSON.stringify({ cancelReason }) : undefined,
  });
}
