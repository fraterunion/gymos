"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api/errors";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import {
  type BuildJobDto,
  type BuildJobPlatform,
  type BuildJobProfile,
  type BuildPipelinePhase,
  type BuildWorkerReadinessDto,
  BUILD_PIPELINE_LABELS,
  ERROR_CATEGORY_LABELS,
  createBuildJob,
  fetchBuildJobs,
  fetchBuildWorkerInfo,
  formatExpoBuildStatus,
  getBuildPipelinePhase,
  isBuildLive,
  runBuildJob,
} from "@/lib/api/buildJobs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PHASE_BADGE: Record<BuildPipelinePhase, string> = {
  waiting:          "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  submitting:       "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  building_on_expo: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  completed:        "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  failed:           "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  canceled:         "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function PlatformPill({ platform }: { platform: BuildJobPlatform }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold ${
      platform === "IOS"
        ? "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300"
        : "bg-lime-50 text-lime-700 dark:bg-lime-900/30 dark:text-lime-300"
    }`}>
      {platform === "IOS" ? "iOS" : "Android"}
    </span>
  );
}

function PhaseBadge({ job }: { job: BuildJobDto }) {
  const phase = getBuildPipelinePhase(job);
  const expoLabel = formatExpoBuildStatus(job.expoBuildStatus);
  const label = BUILD_PIPELINE_LABELS[phase];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${PHASE_BADGE[phase]}`}>
      {phase === "building_on_expo" && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {label}
      {expoLabel && phase === "building_on_expo" && (
        <span className="opacity-60">· {expoLabel}</span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function BuildsPage() {
  const { selectedStudioId, selected } = useDeskStudio();
  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [jobs, setJobs] = useState<BuildJobDto[]>([]);
  const [workerInfo, setWorkerInfo] = useState<BuildWorkerReadinessDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New-build form state
  const [showForm, setShowForm] = useState(false);
  const [formPlatform, setFormPlatform] = useState<BuildJobPlatform>("ANDROID");
  const [formProfile, setFormProfile] = useState<BuildJobProfile>("PREVIEW");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Retry state per job
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedStudioId || !canManage) return;
    setLoading(true);
    setError(null);
    try {
      const [jobsRes, workerRes] = await Promise.all([
        fetchBuildJobs(selectedStudioId),
        fetchBuildWorkerInfo(selectedStudioId),
      ]);
      setJobs(jobsRes);
      setWorkerInfo(workerRes);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to load builds");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, canManage]);

  // Initial load
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Auto-refresh every 30 s while any job is live
  const hasLiveJobs = jobs.some(isBuildLive);
  useEffect(() => {
    if (!hasLiveJobs) return;
    const interval = setInterval(() => void load(), 30_000);
    return () => clearInterval(interval);
  }, [hasLiveJobs, load]);

  // Handle new build submission
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedStudioId) return;
    setSubmitting(true);
    setFormError(null);
    try {
      await createBuildJob(selectedStudioId, { platform: formPlatform, profile: formProfile });
      setShowForm(false);
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Failed to queue build");
    } finally {
      setSubmitting(false);
    }
  }

  // Handle retry for failed jobs
  async function handleRetry(jobId: string) {
    if (!selectedStudioId) return;
    setRetrying(jobId);
    try {
      await runBuildJob(selectedStudioId, jobId);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to retry build");
    } finally {
      setRetrying(null);
    }
  }

  if (!canManage) {
    return (
      <div className="py-16 text-center text-sm text-zinc-500">
        You need Owner or Admin access to view builds.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">Mobile Builds</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            EAS cloud builds for this studio&apos;s white-label app.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setShowForm((v) => !v); setFormError(null); }}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {showForm ? "Cancel" : "New build"}
        </button>
      </div>

      {/* New build form */}
      {showForm && (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-300">Queue a new EAS build</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Platform
              <select
                value={formPlatform}
                onChange={(e) => setFormPlatform(e.target.value as BuildJobPlatform)}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="ANDROID">Android</option>
                <option value="IOS">iOS</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-500">
              Profile
              <select
                value={formProfile}
                onChange={(e) => setFormProfile(e.target.value as BuildJobProfile)}
                className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              >
                <option value="PREVIEW">Preview (internal)</option>
                <option value="PRODUCTION">Production</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              {submitting ? "Queuing…" : "Queue build"}
            </button>
          </div>
          {formError && <p className="mt-2 text-xs text-red-600">{formError}</p>}
        </form>
      )}

      {/* Worker status */}
      {workerInfo && !workerInfo.canExecuteBuilds && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/50 dark:bg-amber-900/20">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Build worker not ready</p>
          <ul className="mt-1 space-y-0.5">
            {workerInfo.blockingReasons.map((r) => (
              <li key={r} className="text-xs text-amber-700 dark:text-amber-400">· {r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </p>
      )}

      {/* Jobs table */}
      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 text-left text-xs font-medium text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-3">Platform / Profile</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">App</th>
              <th className="px-4 py-3">EAS build</th>
              <th className="px-4 py-3">Artifact</th>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3">Last checked</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {loading && jobs.length === 0 ? (
              Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800">
                  {Array.from({ length: 8 }).map((__, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-4 w-24 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
                    </td>
                  ))}
                </tr>
              ))
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-sm text-zinc-400">
                  No builds yet. Queue one with &quot;New build&quot;.
                </td>
              </tr>
            ) : (
              jobs.map((job) => {
                const phase = getBuildPipelinePhase(job);
                const canRetry = job.status === "FAILED";
                return (
                  <tr
                    key={job.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-800"
                  >
                    {/* Platform / Profile */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <PlatformPill platform={job.platform} />
                        <span className="text-xs text-zinc-500">
                          {job.profile === "PREVIEW" ? "Preview" : "Production"}
                        </span>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <PhaseBadge job={job} />
                      {job.errorCategory && (
                        <p className="mt-0.5 text-xs text-zinc-400">
                          {ERROR_CATEGORY_LABELS[job.errorCategory]}
                        </p>
                      )}
                    </td>

                    {/* App */}
                    <td className="px-4 py-3">
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">
                        {job.appDisplayName}
                      </p>
                      <p className="text-xs text-zinc-400">{job.appScheme}</p>
                    </td>

                    {/* EAS build link */}
                    <td className="px-4 py-3">
                      {job.easBuildUrl ? (
                        <a
                          href={job.easBuildUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          View on Expo ↗
                        </a>
                      ) : (
                        <span className="text-xs text-zinc-300 dark:text-zinc-600">—</span>
                      )}
                    </td>

                    {/* Artifact */}
                    <td className="px-4 py-3">
                      {job.artifactUrl ? (
                        <a
                          href={job.artifactUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          Download
                        </a>
                      ) : phase === "completed" ? (
                        <span className="text-xs text-zinc-400">Not captured</span>
                      ) : (
                        <span className="text-xs text-zinc-300 dark:text-zinc-600">—</span>
                      )}
                    </td>

                    {/* Requested */}
                    <td className="px-4 py-3 text-xs text-zinc-500">
                      {formatRelative(job.requestedAt)}
                    </td>

                    {/* Last checked */}
                    <td className="px-4 py-3 text-xs text-zinc-500">
                      {formatRelative(job.lastCheckedAt)}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      {canRetry && (
                        <button
                          type="button"
                          disabled={retrying === job.id}
                          onClick={() => void handleRetry(job.id)}
                          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        >
                          {retrying === job.id ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Error details panel for the most recent failed job */}
      {jobs.find((j) => j.status === "FAILED" && j.errorMessage) && (() => {
        const failed = jobs.find((j) => j.status === "FAILED" && j.errorMessage)!;
        return (
          <details className="rounded-xl border border-red-200 bg-red-50 dark:border-red-800/50 dark:bg-red-900/20">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-red-700 dark:text-red-300">
              Last failure details
            </summary>
            <pre className="overflow-x-auto px-4 pb-4 pt-2 text-xs text-red-700 dark:text-red-400 whitespace-pre-wrap break-words">
              {failed.errorMessage}
            </pre>
          </details>
        );
      })()}

      {/* Polling indicator */}
      {hasLiveJobs && (
        <p className="text-center text-xs text-zinc-400">
          Refreshing automatically every 30 s while builds are in progress…
        </p>
      )}
    </div>
  );
}
