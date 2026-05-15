"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { CopyFieldRow } from "@/components/CopyFieldRow";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  createBuildJob,
  fetchBuildJobs,
  fetchBuildWorkerInfo,
  runBuildJob,
  type BuildJobDto,
  type BuildJobPlatform,
  type BuildJobProfile,
} from "@/lib/api/buildJobs";
import {
  fetchStudioSettings,
  updateGeneralSettings,
  updateMobileConfig,
  type StudioSettingsDto,
} from "@/lib/api/settings";

const INPUT =
  "w-full rounded-xl border border-zinc-700/90 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30";

const STATUS_HELP: Record<BuildJobDto["status"], string> = {
  QUEUED: "Waiting for worker",
  RUNNING: "EAS build in progress",
  SUCCEEDED: "Build finished",
  FAILED: "Failed; can re-queue",
  CANCELED: "Canceled",
};

function StatusCell({ status }: { status: BuildJobDto["status"] }) {
  const styles: Record<BuildJobDto["status"], string> = {
    QUEUED: "bg-zinc-500/15 text-zinc-300 ring-1 ring-zinc-500/30",
    RUNNING: "bg-sky-500/15 text-sky-200 ring-1 ring-sky-500/35",
    SUCCEEDED: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/35",
    FAILED: "bg-red-500/15 text-red-200 ring-1 ring-red-500/35",
    CANCELED: "bg-zinc-600/20 text-zinc-400 ring-1 ring-zinc-600/40",
  };
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles[status]}`}>
        {status}
      </span>
      <span className="max-w-[140px] text-[10px] leading-tight text-zinc-500">{STATUS_HELP[status]}</span>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  headerExtra,
  children,
}: {
  title: string;
  subtitle?: string;
  headerExtra?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/35 p-6 shadow-sm backdrop-blur-sm">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-zinc-50">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
        </div>
        {headerExtra ? <div className="shrink-0">{headerExtra}</div> : null}
      </div>
      {children}
    </section>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-start gap-2.5 text-sm text-zinc-300">
      <span
        className={`mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-xs font-bold ${
          ok ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/35" : "bg-zinc-800 text-zinc-500"
        }`}
        aria-hidden
      >
        {ok ? "✓" : ""}
      </span>
      <span>{label}</span>
    </li>
  );
}

function applyFormsFromDto(res: StudioSettingsDto) {
  const m = res.mobile ?? {
    appDisplayName: null,
    appScheme: null,
    expoSlug: null,
    iosBundleIdentifier: null,
    androidPackage: null,
  };
  return {
    mobile: {
      appDisplayName: m.appDisplayName ?? "",
      appScheme: m.appScheme ?? "",
      expoSlug: m.expoSlug ?? "",
      iosBundleIdentifier: m.iosBundleIdentifier ?? "",
      androidPackage: m.androidPackage ?? "",
    },
    legal: {
      privacyUrl: res.general.privacyUrl ?? "",
      termsUrl: res.general.termsUrl ?? "",
    },
  };
}

type SaveKey = "mobile" | "legal";

export default function PlatformConsolePage() {
  const { selectedStudioId, selected, loading: studiosLoading, error: studiosError } = useDeskStudio();
  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [data, setData] = useState<StudioSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SaveKey | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [jobs, setJobs] = useState<BuildJobDto[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [buildModalOpen, setBuildModalOpen] = useState(false);
  const [buildPlatform, setBuildPlatform] = useState<BuildJobPlatform>("IOS");
  const [buildProfile, setBuildProfile] = useState<BuildJobProfile>("PREVIEW");
  const [createJobPending, setCreateJobPending] = useState(false);
  const [workerEnabled, setWorkerEnabled] = useState(false);
  const [enqueuingJobId, setEnqueuingJobId] = useState<string | null>(null);

  const [mobile, setMobile] = useState({
    appDisplayName: "",
    appScheme: "",
    expoSlug: "",
    iosBundleIdentifier: "",
    androidPackage: "",
  });
  const [legal, setLegal] = useState({ privacyUrl: "", termsUrl: "" });

  const applyServerData = useCallback((res: StudioSettingsDto) => {
    setData(res);
    const f = applyFormsFromDto(res);
    setMobile(f.mobile);
    setLegal(f.legal);
  }, []);

  const reload = useCallback(async () => {
    if (!selectedStudioId || !canManage) {
      setData(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchStudioSettings(selectedStudioId);
      if (!res.mobile) {
        setLoadError(
          "Mobile configuration was not returned for this session. Confirm your account is a platform operator and matches API allowlist (email domain / PLATFORM_EXTRA_OPERATOR_EMAILS).",
        );
        setData(null);
        return;
      }
      applyServerData(res);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 403
            ? "Forbidden — you need owner or admin membership on this studio, and platform email access for mobile fields."
            : e.message
          : "Could not load tenant.";
      setLoadError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, canManage, applyServerData]);

  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
  }, [reload]);

  const loadBuildJobs = useCallback(async () => {
    if (!selectedStudioId || !canManage) {
      setJobs([]);
      setJobsError(null);
      return;
    }
    setJobsLoading(true);
    setJobsError(null);
    try {
      setJobs(await fetchBuildJobs(selectedStudioId));
    } catch (e) {
      setJobs([]);
      setJobsError(e instanceof ApiError ? e.message : "Could not load build jobs.");
    } finally {
      setJobsLoading(false);
    }
  }, [selectedStudioId, canManage]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadBuildJobs();
    });
  }, [loadBuildJobs]);

  const activeBuildWatch = useMemo(
    () => jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING"),
    [jobs],
  );

  useEffect(() => {
    if (!selectedStudioId || !canManage || !activeBuildWatch) return;
    const id = window.setInterval(() => {
      void loadBuildJobs();
    }, 8000);
    return () => window.clearInterval(id);
  }, [selectedStudioId, canManage, activeBuildWatch, loadBuildJobs]);

  const loadWorkerInfo = useCallback(async () => {
    if (!selectedStudioId || !canManage) {
      setWorkerEnabled(false);
      return;
    }
    try {
      const r = await fetchBuildWorkerInfo(selectedStudioId);
      setWorkerEnabled(r.workerEnabled);
    } catch {
      setWorkerEnabled(false);
    }
  }, [selectedStudioId, canManage]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadWorkerInfo();
    });
  }, [loadWorkerInfo]);

  const mobileDraftReady = useMemo(() => {
    const fields = [
      mobile.appDisplayName,
      mobile.appScheme,
      mobile.expoSlug,
      mobile.iosBundleIdentifier,
      mobile.androidPackage,
    ].map((x) => x.trim());
    return fields.every((x) => x.length > 0);
  }, [mobile]);

  const checklist = useMemo(() => {
    if (!data) return null;
    const logoOk = !!(data.branding.effectiveLogoUrl?.trim() || data.branding.logoUrl?.trim());
    const nameOk = !!(data.mobile?.appDisplayName?.trim());
    const colorsOk = !!(
      (data.branding.primaryColor ?? data.branding.legacyBrandPrimaryColor)?.trim() &&
      (data.branding.accentColor ?? data.branding.legacyBrandSecondaryColor)?.trim()
    );
    const bundleOk = !!(
      data.mobile?.iosBundleIdentifier?.trim() && data.mobile?.androidPackage?.trim()
    );
    const privacyOk = !!(data.general.privacyUrl?.trim());
    const termsOk = !!(data.general.termsUrl?.trim());
    return { logoOk, nameOk, colorsOk, bundleOk, privacyOk, termsOk };
  }, [data]);

  async function runSave(key: SaveKey, fn: () => Promise<StudioSettingsDto>) {
    if (!selectedStudioId) return;
    setSectionError(null);
    setSaving(key);
    try {
      const next = await fn();
      if (!next.mobile) {
        setSectionError("Save succeeded but mobile payload was missing — check platform operator configuration.");
        return;
      }
      applyServerData(next);
      void loadBuildJobs();
      setFlash("Saved");
      window.setTimeout(() => setFlash(null), 2200);
    } catch (e) {
      setSectionError(e instanceof ApiError ? e.message : "Save failed.");
    } finally {
      setSaving(null);
    }
  }

  const onSaveMobile = () => {
    if (!selectedStudioId) return;
    void runSave("mobile", () =>
      updateMobileConfig(selectedStudioId, {
        appDisplayName: mobile.appDisplayName.trim() || null,
        appScheme: mobile.appScheme.trim() || null,
        expoSlug: mobile.expoSlug.trim() || null,
        iosBundleIdentifier: mobile.iosBundleIdentifier.trim() || null,
        androidPackage: mobile.androidPackage.trim() || null,
      }),
    );
  };

  const onSaveLegal = () => {
    if (!selectedStudioId) return;
    void runSave("legal", () =>
      updateGeneralSettings(selectedStudioId, {
        privacyUrl: legal.privacyUrl.trim() || null,
        termsUrl: legal.termsUrl.trim() || null,
      }),
    );
  };

  const onCreateBuildJob = async () => {
    if (!selectedStudioId) return;
    setSectionError(null);
    setCreateJobPending(true);
    try {
      await createBuildJob(selectedStudioId, { platform: buildPlatform, profile: buildProfile });
      setBuildModalOpen(false);
      setFlash("Build job queued");
      window.setTimeout(() => setFlash(null), 2200);
      await loadBuildJobs();
      void loadWorkerInfo();
    } catch (e) {
      setSectionError(e instanceof ApiError ? e.message : "Could not create build job.");
    } finally {
      setCreateJobPending(false);
    }
  };

  const onEnqueueJob = async (jobId: string) => {
    if (!selectedStudioId) return;
    setSectionError(null);
    setEnqueuingJobId(jobId);
    try {
      await runBuildJob(selectedStudioId, jobId);
      setFlash("Build queued — the API worker will pick it up shortly.");
      window.setTimeout(() => setFlash(null), 2800);
      await loadBuildJobs();
    } catch (e) {
      setSectionError(e instanceof ApiError ? e.message : "Could not enqueue build.");
      await loadBuildJobs();
    } finally {
      setEnqueuingJobId(null);
    }
  };

  if (studiosLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-zinc-500">Loading studios…</p>
      </div>
    );
  }

  if (studiosError) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-200">{studiosError}</div>
    );
  }

  if (!canManage) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h2 className="text-lg font-semibold text-zinc-100">Owner or admin required</h2>
        <p className="mt-2 text-sm text-zinc-500">
          Platform tools still use studio membership. Ask for ADMIN on this tenant, or switch studio in the header.
        </p>
      </div>
    );
  }

  if (!selectedStudioId) {
    return <p className="text-sm text-zinc-500">Select a tenant in the header.</p>;
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-900/40" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="rounded-xl border border-amber-900/40 bg-amber-950/15 p-4 text-sm text-amber-100">{loadError}</div>
    );
  }

  return (
    <div className="space-y-8 pb-16">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">Tenant mobile &amp; store readiness</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Bundle identifiers and Expo metadata for white-label builds. Store URLs and legal links are required for
            app review.
          </p>
        </div>
        {flash ? (
          <span className="text-xs font-medium text-emerald-400" role="status">
            {flash}
          </span>
        ) : (
          <span className="text-xs text-zinc-600">Updated {new Date(data.updatedAt).toLocaleString()}</span>
        )}
      </header>

      <div className="rounded-xl border border-amber-900/35 bg-amber-950/10 px-4 py-3 text-sm text-amber-100/95">
        <strong className="font-semibold text-amber-200">Production warning.</strong> Changing the iOS bundle identifier
        or Android application ID after a store release usually requires a new listing. Coordinate with engineering
        before editing live tenants.
      </div>

      {sectionError ? (
        <div className="rounded-xl border border-red-900/40 bg-red-950/15 px-4 py-3 text-sm text-red-200">
          {sectionError}
        </div>
      ) : null}

      <SectionCard
        title="Mobile app configuration"
        subtitle="Native identifiers and Expo project slug. Copied values reflect the form below."
      >
        <div className="mb-6 grid gap-2 sm:grid-cols-2">
          <CopyFieldRow label="App display name" value={mobile.appDisplayName || null} />
          <CopyFieldRow label="App scheme" value={mobile.appScheme || null} />
          <CopyFieldRow label="Expo slug" value={mobile.expoSlug || null} />
          <CopyFieldRow label="iOS bundle identifier" value={mobile.iosBundleIdentifier || null} />
          <CopyFieldRow label="Android package" value={mobile.androidPackage || null} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">App display name</span>
            <input
              className={INPUT}
              value={mobile.appDisplayName}
              onChange={(e) => setMobile((m) => ({ ...m, appDisplayName: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">App scheme</span>
            <input className={INPUT} value={mobile.appScheme} onChange={(e) => setMobile((m) => ({ ...m, appScheme: e.target.value }))} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Expo slug</span>
            <input className={INPUT} value={mobile.expoSlug} onChange={(e) => setMobile((m) => ({ ...m, expoSlug: e.target.value }))} />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">iOS bundle identifier</span>
            <input
              className={INPUT}
              value={mobile.iosBundleIdentifier}
              onChange={(e) => setMobile((m) => ({ ...m, iosBundleIdentifier: e.target.value }))}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Android package</span>
            <input
              className={INPUT}
              value={mobile.androidPackage}
              onChange={(e) => setMobile((m) => ({ ...m, androidPackage: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "mobile"}
            onClick={onSaveMobile}
            className="rounded-xl bg-amber-500/90 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-wait disabled:opacity-60"
          >
            {saving === "mobile" ? "Saving…" : "Save mobile config"}
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="White-label build requests"
        subtitle="Queue tracked requests; the API worker runs EAS builds asynchronously when enabled (no store publishing from GymOS)."
      >
        <p className="rounded-xl border border-zinc-800/70 bg-zinc-950/40 px-4 py-3 text-sm leading-relaxed text-zinc-400">
          <strong className="font-medium text-zinc-200">Store releases are separate.</strong> This flow only starts Expo
          Application Services (EAS) cloud builds and records URLs on the job. When{" "}
          <span className="font-mono text-zinc-300">BUILD_WORKER_ENABLED=true</span> on the API, use{" "}
          <strong className="text-zinc-200">Enqueue</strong> so a background worker picks up{" "}
          <span className="font-mono text-zinc-300">QUEUED</span> rows (or re-queues{" "}
          <span className="font-mono text-zinc-300">FAILED</span>).
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4">
          <div>
            <p className="text-sm font-medium text-zinc-100">Mobile snapshot readiness</p>
            <p className="mt-1 text-xs text-zinc-500">All mobile fields must be saved on the studio before queuing a job.</p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              mobileDraftReady
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30"
                : "bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/25"
            }`}
          >
            {mobileDraftReady ? "Ready" : "Incomplete"}
          </span>
        </div>
        <div className="mt-4">
          <button
            type="button"
            disabled={!mobileDraftReady}
            title={!mobileDraftReady ? "Complete and save mobile configuration first." : undefined}
            onClick={() => setBuildModalOpen(true)}
            className="rounded-xl bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Generate build
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Recent build jobs"
        subtitle="Latest 50 requests for this tenant (newest first)."
        headerExtra={
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={() => void loadBuildJobs()}
              disabled={jobsLoading}
              className="rounded-lg border border-zinc-600 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-50"
            >
              {jobsLoading ? "Refreshing…" : "Refresh"}
            </button>
            {activeBuildWatch ? (
              <span className="text-[10px] text-zinc-500">Auto-refresh every 8s while QUEUED/RUNNING</span>
            ) : null}
          </div>
        }
      >
        {!workerEnabled ? (
          <div className="mb-4 rounded-xl border border-amber-900/40 bg-amber-950/15 px-3 py-2 text-xs leading-relaxed text-amber-100">
            <strong className="font-medium text-amber-200">Build worker is disabled in this environment.</strong> Enqueue
            actions stay disabled until the API sets{" "}
            <span className="font-mono text-amber-100/90">BUILD_WORKER_ENABLED=true</span> and EAS credentials.
          </div>
        ) : null}
        {jobsError ? (
          <p className="mb-3 text-sm text-red-300">{jobsError}</p>
        ) : null}
        {jobsLoading ? (
          <p className="text-sm text-zinc-500">Loading jobs…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-zinc-500">No build jobs yet. Queue one with Generate build.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-800/80">
            <table className="min-w-[1000px] w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-950/80 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  <th className="px-3 py-2">Requested</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Target</th>
                  <th className="px-3 py-2">Snapshot</th>
                  <th className="px-3 py-2">Links / errors</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-zinc-800/60 last:border-0">
                    <td className="whitespace-nowrap px-3 py-2.5 text-zinc-400">
                      {new Date(job.requestedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusCell status={job.status} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-zinc-300">
                      {job.platform} · {job.profile}
                    </td>
                    <td className="max-w-[340px] px-3 py-2.5">
                      <div className="space-y-0.5 font-mono text-[11px] leading-snug text-zinc-400">
                        <div className="truncate text-zinc-300" title={job.appDisplayName}>
                          {job.appDisplayName}
                        </div>
                        <div>scheme {job.appScheme}</div>
                        <div>slug {job.expoSlug}</div>
                        <div className="truncate" title={job.iosBundleIdentifier}>
                          ios {job.iosBundleIdentifier}
                        </div>
                        <div className="truncate" title={job.androidPackage}>
                          and {job.androidPackage}
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[220px] px-3 py-2.5 align-top">
                      <div className="space-y-1.5 text-[11px]">
                        {job.easBuildUrl ? (
                          <a
                            href={job.easBuildUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-sky-400 hover:underline"
                          >
                            EAS build
                          </a>
                        ) : (
                          <span className="text-zinc-600">EAS: —</span>
                        )}
                        {job.artifactUrl ? (
                          <a
                            href={job.artifactUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-sky-400 hover:underline"
                          >
                            Artifact
                          </a>
                        ) : (
                          <span className="text-zinc-600">Artifact: —</span>
                        )}
                        {job.errorMessage ? (
                          <p className="text-red-300/95" title={job.errorMessage}>
                            {job.errorMessage}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top">
                      <button
                        type="button"
                        disabled={
                          !workerEnabled ||
                          enqueuingJobId === job.id ||
                          (job.status !== "QUEUED" && job.status !== "FAILED")
                        }
                        title={
                          !workerEnabled
                            ? "Build worker is disabled in this environment."
                            : job.status !== "QUEUED" && job.status !== "FAILED"
                              ? "Only QUEUED or FAILED jobs can be enqueued."
                              : undefined
                        }
                        onClick={() => void onEnqueueJob(job.id)}
                        className="rounded-lg border border-zinc-600 px-2.5 py-1 text-[11px] font-semibold text-zinc-100 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {enqueuingJobId === job.id ? "Enqueuing…" : "Enqueue"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="App Store listing — legal URLs" subtitle="Required for review; stored on the studio record.">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Privacy policy URL</span>
            <input
              className={INPUT}
              placeholder="https://"
              value={legal.privacyUrl}
              onChange={(e) => setLegal((l) => ({ ...l, privacyUrl: e.target.value }))}
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Terms of service URL</span>
            <input
              className={INPUT}
              placeholder="https://"
              value={legal.termsUrl}
              onChange={(e) => setLegal((l) => ({ ...l, termsUrl: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "legal"}
            onClick={onSaveLegal}
            className="rounded-xl border border-zinc-600 px-4 py-2.5 text-sm font-semibold text-zinc-100 hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
          >
            {saving === "legal" ? "Saving…" : "Save legal URLs"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Store listing readiness" subtitle="Checklist against the current tenant record (not live store API).">
        {checklist ? (
          <ul className="space-y-2">
            <CheckRow ok={checklist.logoOk} label="Logo configured (desk branding)" />
            <CheckRow ok={checklist.nameOk} label="App display name" />
            <CheckRow ok={checklist.colorsOk} label="Primary & accent colors" />
            <CheckRow ok={checklist.bundleOk} label="iOS bundle ID & Android package" />
            <CheckRow ok={checklist.privacyOk} label="Privacy policy URL" />
            <CheckRow ok={checklist.termsOk} label="Terms of service URL" />
          </ul>
        ) : null}
        <p className="mt-4 text-xs text-zinc-600">
          App Store / Play Console assets and screenshots are managed outside GymOS.
        </p>
      </SectionCard>

      {buildModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
            aria-label="Close dialog"
            disabled={createJobPending}
            onClick={() => !createJobPending && setBuildModalOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="build-modal-title"
            className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
          >
            <h3 id="build-modal-title" className="text-lg font-semibold text-zinc-50">
              New build job
            </h3>
            <p className="mt-2 text-sm text-zinc-500">
              Queues a <span className="font-mono text-zinc-400">QUEUED</span> record with a snapshot of the
              studio&apos;s saved mobile configuration. EAS runs asynchronously on the API when the build worker is
              enabled.
            </p>
            <div className="mt-5 space-y-4">
              <fieldset>
                <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Platform</legend>
                <div className="flex flex-wrap gap-3">
                  {(["IOS", "ANDROID"] as const).map((p) => (
                    <label key={p} className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
                      <input
                        type="radio"
                        name="build-platform"
                        checked={buildPlatform === p}
                        onChange={() => setBuildPlatform(p)}
                        className="border-zinc-600 text-amber-600 focus:ring-amber-500/40"
                      />
                      {p === "IOS" ? "iOS" : "Android"}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Profile</legend>
                <div className="flex flex-wrap gap-3">
                  {(["PREVIEW", "PRODUCTION"] as const).map((p) => (
                    <label key={p} className="flex cursor-pointer items-center gap-2 text-sm text-zinc-200">
                      <input
                        type="radio"
                        name="build-profile"
                        checked={buildProfile === p}
                        onChange={() => setBuildProfile(p)}
                        className="border-zinc-600 text-amber-600 focus:ring-amber-500/40"
                      />
                      {p === "PREVIEW" ? "Preview" : "Production"}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                disabled={createJobPending}
                onClick={() => setBuildModalOpen(false)}
                className="rounded-xl border border-zinc-600 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={createJobPending}
                onClick={() => void onCreateBuildJob()}
                className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:cursor-wait disabled:opacity-60"
              >
                {createJobPending ? "Creating…" : "Queue build job"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
