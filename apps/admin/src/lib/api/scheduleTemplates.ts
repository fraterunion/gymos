import { apiRequest } from "@/lib/api/client";

export type ScheduleTemplateDto = {
  id: string;
  studioId: string;
  classTemplateId: string;
  instructorId: string | null;
  dayOfWeek: number;
  startTime: string;
  capacity: number | null;
  active: boolean;
  classTemplate: {
    id: string;
    name: string;
    durationMinutes: number;
    color: string | null;
    defaultCapacity: number;
  };
  instructor: { id: string; firstName: string; lastName: string } | null;
};

export type CreateScheduleTemplateInput = {
  classTemplateId: string;
  dayOfWeek: number;
  startTime: string;
  instructorId?: string | null;
  capacity?: number | null;
};

export type UpdateScheduleTemplateInput = Partial<CreateScheduleTemplateInput> & {
  active?: boolean;
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export async function fetchScheduleTemplates(
  studioId: string,
): Promise<ScheduleTemplateDto[]> {
  return apiRequest<ScheduleTemplateDto[]>(
    `/studios/${studioId}/schedule-templates`,
  );
}

export async function createScheduleTemplate(
  studioId: string,
  input: CreateScheduleTemplateInput,
): Promise<ScheduleTemplateDto> {
  return apiRequest<ScheduleTemplateDto>(
    `/studios/${studioId}/schedule-templates`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function updateScheduleTemplate(
  studioId: string,
  id: string,
  input: UpdateScheduleTemplateInput,
): Promise<ScheduleTemplateDto> {
  return apiRequest<ScheduleTemplateDto>(
    `/studios/${studioId}/schedule-templates/${id}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export async function deleteScheduleTemplate(
  studioId: string,
  id: string,
): Promise<void> {
  await apiRequest<void>(`/studios/${studioId}/schedule-templates/${id}`, {
    method: "DELETE",
  });
}
