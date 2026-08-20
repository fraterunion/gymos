import { apiRequest } from "@/lib/api/client";

export type DayPassClassAccessTemplateDto = {
  id: string;
  name: string;
  durationMinutes: number;
  isOpenGymSlot: boolean;
  active: boolean;
  allowed: boolean;
};

export function fetchDayPassClassAccess(
  studioId: string,
): Promise<DayPassClassAccessTemplateDto[]> {
  return apiRequest<DayPassClassAccessTemplateDto[]>(
    `/studios/${studioId}/day-pass-class-access`,
  );
}

export function grantDayPassClassAccess(
  studioId: string,
  classTemplateId: string,
): Promise<void> {
  return apiRequest<void>(`/studios/${studioId}/day-pass-class-access`, {
    method: "POST",
    body: JSON.stringify({ classTemplateId }),
  });
}

export function revokeDayPassClassAccess(
  studioId: string,
  classTemplateId: string,
): Promise<void> {
  return apiRequest<void>(
    `/studios/${studioId}/day-pass-class-access/${classTemplateId}`,
    { method: "DELETE" },
  );
}
