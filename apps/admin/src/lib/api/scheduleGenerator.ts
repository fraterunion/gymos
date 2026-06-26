import { apiRequest } from "@/lib/api/client";

export type GenerateMode =
  | "NEXT_30"
  | "NEXT_90"
  | "END_OF_YEAR"
  | "CUSTOM";

export type GenerationSummary = {
  generated: number;
  skipped: number;
  conflicts: number;
  errors: number;
  durationMs: number;
  runId?: string;
  breakdown: Record<string, { name: string; generated: number; skipped: number }>;
};

export type GeneratorStatus = {
  lastClassDate: string | null;
  futureDays: number;
  templateCount: number;
};

export type GenerationRun = {
  id: string;
  triggeredBy: "MANUAL" | "AUTOMATIC";
  isDryRun: boolean;
  fromDate: string;
  toDate: string;
  generated: number;
  skipped: number;
  conflicts: number;
  errors: number;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
  user: { id: string; firstName: string; lastName: string } | null;
};

export type AutomationSettings = {
  enabled: boolean;
  minFutureDays: number;
};

export async function fetchGeneratorStatus(
  studioId: string,
): Promise<GeneratorStatus> {
  return apiRequest<GeneratorStatus>(
    `/studios/${studioId}/schedule-generator/status`,
  );
}

export async function previewGeneration(
  studioId: string,
  mode: GenerateMode,
  toDate?: string,
): Promise<GenerationSummary> {
  return apiRequest<GenerationSummary>(
    `/studios/${studioId}/schedule-generator/preview`,
    { method: "POST", body: JSON.stringify({ mode, toDate }) },
  );
}

export async function runGeneration(
  studioId: string,
  mode: GenerateMode,
  toDate?: string,
): Promise<GenerationSummary> {
  return apiRequest<GenerationSummary>(
    `/studios/${studioId}/schedule-generator/generate`,
    { method: "POST", body: JSON.stringify({ mode, toDate }) },
  );
}

export async function fetchGenerationRuns(
  studioId: string,
): Promise<GenerationRun[]> {
  return apiRequest<GenerationRun[]>(
    `/studios/${studioId}/schedule-generator/runs`,
  );
}

export async function fetchAutomation(
  studioId: string,
): Promise<AutomationSettings> {
  return apiRequest<AutomationSettings>(
    `/studios/${studioId}/schedule-generator/automation`,
  );
}

export async function updateAutomation(
  studioId: string,
  settings: AutomationSettings,
): Promise<AutomationSettings> {
  return apiRequest<AutomationSettings>(
    `/studios/${studioId}/schedule-generator/automation`,
    { method: "PATCH", body: JSON.stringify(settings) },
  );
}
