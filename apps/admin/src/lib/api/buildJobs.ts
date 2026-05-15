import { apiRequest } from "@/lib/api/client";

export type BuildJobPlatform = "IOS" | "ANDROID";
export type BuildJobProfile = "PREVIEW" | "PRODUCTION";
export type BuildJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type BuildJobDto = {
  id: string;
  studioId: string;
  requestedByUserId: string;
  platform: BuildJobPlatform;
  profile: BuildJobProfile;
  status: BuildJobStatus;
  appDisplayName: string;
  appScheme: string;
  expoSlug: string;
  iosBundleIdentifier: string;
  androidPackage: string;
  easBuildUrl: string | null;
  artifactUrl: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function fetchBuildJobs(studioId: string): Promise<BuildJobDto[]> {
  return apiRequest<BuildJobDto[]>(`/studios/${studioId}/build-jobs`, { method: "GET" });
}

export async function createBuildJob(
  studioId: string,
  body: { platform: BuildJobPlatform; profile: BuildJobProfile },
): Promise<BuildJobDto> {
  return apiRequest<BuildJobDto>(`/studios/${studioId}/build-jobs`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
