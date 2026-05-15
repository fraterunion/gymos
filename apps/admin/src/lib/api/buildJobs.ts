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

export async function fetchBuildJob(studioId: string, jobId: string): Promise<BuildJobDto> {
  return apiRequest<BuildJobDto>(`/studios/${studioId}/build-jobs/${encodeURIComponent(jobId)}`, { method: "GET" });
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

export type BuildWorkerReadinessDto = {
  workerEnabled: boolean;
  pollIntervalMs: number;
  mobileAppRoot: string | null;
  mobileAppRootExists: boolean;
  easTokenConfigured: boolean;
  expoPublicApiUrlConfigured: boolean;
  npxAvailable: boolean;
  easCliReachable: boolean;
  easCliVersion?: string;
  canExecuteBuilds: boolean;
  blockingReasons: string[];
};

/** @deprecated Use BuildWorkerReadinessDto */
export type BuildWorkerInfoDto = BuildWorkerReadinessDto;

export async function fetchBuildWorkerInfo(studioId: string): Promise<BuildWorkerReadinessDto> {
  return apiRequest<BuildWorkerReadinessDto>(`/studios/${studioId}/build-jobs/worker-info`, { method: "GET" });
}

export async function runBuildJob(studioId: string, jobId: string): Promise<BuildJobDto> {
  return apiRequest<BuildJobDto>(`/studios/${studioId}/build-jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
  });
}
