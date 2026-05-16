import { apiRequest } from "@/lib/api/client";

export type BuildJobPlatform = "IOS" | "ANDROID";
export type BuildJobProfile = "PREVIEW" | "PRODUCTION";
export type BuildJobStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type BuildJobErrorCategory =
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "EAS_OUTAGE"
  | "BUILD_FAILED"
  | "TIMEOUT"
  | "UNKNOWN";

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
  errorCategory: BuildJobErrorCategory | null;
  submittedAt: string | null;
  expoBuildId: string | null;
  expoBuildStatus: string | null;
  lastCheckedAt: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Human-facing pipeline phase for Platform Console. */
export type BuildPipelinePhase =
  | "waiting"
  | "submitting"
  | "building_on_expo"
  | "completed"
  | "failed"
  | "canceled";

export function getBuildPipelinePhase(job: BuildJobDto): BuildPipelinePhase {
  if (job.status === "CANCELED") return "canceled";
  if (job.status === "FAILED") return "failed";
  if (job.status === "QUEUED") return "waiting";
  if (job.status === "RUNNING") {
    if (job.easBuildUrl || job.submittedAt) return "building_on_expo";
    return "submitting";
  }
  if (job.status === "SUCCEEDED") {
    // Expo confirmed the remote build finished
    if (job.expoBuildStatus === "FINISHED") return "completed";
    // Submitted to Expo — remote build still in progress (--no-wait flow)
    if (job.expoBuildId || job.easBuildUrl) return "building_on_expo";
    // Edge case: SUCCEEDED with no EAS tracking info (pre-polling jobs)
    return "completed";
  }
  return "waiting";
}

/** True if the job is not yet in a terminal state and the UI should auto-refresh. */
export function isBuildLive(job: BuildJobDto): boolean {
  return (
    job.status === "QUEUED" ||
    job.status === "RUNNING" ||
    (job.status === "SUCCEEDED" &&
      job.expoBuildStatus !== "FINISHED" &&
      (job.expoBuildId != null || job.easBuildUrl != null))
  );
}

/** Human-readable label for Expo's remote build status value. */
export function formatExpoBuildStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  switch (status) {
    case "SUBMITTED":   return "Submitted";
    case "NEW":         return "Queued";
    case "IN_QUEUE":    return "In queue";
    case "IN_PROGRESS": return "Building";
    case "FINISHED":    return "Finished";
    case "ERRORED":     return "Error";
    case "CANCELED":    return "Canceled";
    default:            return status;
  }
}

export const BUILD_PIPELINE_LABELS: Record<BuildPipelinePhase, string> = {
  waiting: "Queued",
  submitting: "Submitting to EAS",
  building_on_expo: "Building on Expo",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
};

export const ERROR_CATEGORY_LABELS: Record<BuildJobErrorCategory, string> = {
  CONFIG_ERROR: "Configuration",
  AUTH_ERROR: "Authentication",
  EAS_OUTAGE: "EAS / network",
  BUILD_FAILED: "Build failed",
  TIMEOUT: "Timeout",
  UNKNOWN: "Unknown",
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
  /** True when the locally installed eas-cli binary was found and executed successfully. */
  easBinaryFound: boolean;
  easBinaryPath: string | null;
  easCliReachable: boolean;
  easCliVersion?: string;
  canExecuteBuilds: boolean;
  blockingReasons: string[];
};

export async function fetchBuildWorkerInfo(studioId: string): Promise<BuildWorkerReadinessDto> {
  return apiRequest<BuildWorkerReadinessDto>(`/studios/${studioId}/build-jobs/worker-info`, { method: "GET" });
}

export async function runBuildJob(studioId: string, jobId: string): Promise<BuildJobDto> {
  return apiRequest<BuildJobDto>(`/studios/${studioId}/build-jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
  });
}
