import { apiRequest } from "@/lib/api/client";

export type ClassTemplateDto = {
  id: string;
  studioId: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  defaultCapacity: number;
  color: string | null;
  defaultInstructorId: string | null;
  defaultInstructor: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  } | null;
};

export type ClassTemplateInput = {
  name: string;
  description?: string | null;
  durationMinutes: number;
  defaultCapacity?: number;
  color?: string | null;
  instructorId?: string | null;
};

export async function fetchClassTemplates(studioId: string): Promise<ClassTemplateDto[]> {
  return apiRequest<ClassTemplateDto[]>(`/studios/${studioId}/class-templates`, { method: "GET" });
}

export async function createClassTemplate(
  studioId: string,
  input: ClassTemplateInput,
): Promise<ClassTemplateDto> {
  return apiRequest<ClassTemplateDto>(`/studios/${studioId}/class-templates`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateClassTemplate(
  studioId: string,
  templateId: string,
  input: Partial<ClassTemplateInput>,
): Promise<ClassTemplateDto> {
  return apiRequest<ClassTemplateDto>(`/studios/${studioId}/class-templates/${templateId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function archiveClassTemplate(studioId: string, templateId: string): Promise<void> {
  await apiRequest<void>(`/studios/${studioId}/class-templates/${templateId}`, {
    method: "DELETE",
  });
}
