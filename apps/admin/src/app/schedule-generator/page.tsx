"use client";

import { useCallback, useEffect, useState } from "react";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchGeneratorStatus,
  fetchGenerationRuns,
  fetchAutomation,
  previewGeneration,
  runGeneration,
  updateAutomation,
  type GenerateMode,
  type GenerationSummary,
  type GeneratorStatus,
  type GenerationRun,
  type AutomationSettings,
} from "@/lib/api/scheduleGenerator";

const INPUT =
  "w-full rounded-xl border border-zinc-700/90 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/70 focus:outline-none focus:ring-1 focus:ring-violet-500/40";

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-zinc-800/90 bg-zinc-900/40 p-6 shadow-sm backdrop-blur-sm dark:bg-zinc-900/60">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-50">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ days }: { days: number }) {
  const color =
    days >= 60
      ? "bg-emerald-950/60 text-emerald-300 border-emerald-800/50"
      : days >= 30
        ? "bg-amber-950/60 text-amber-300 border-amber-800/50"
        : "bg-red-950/60 text-red-300 border-red-800/50";
  return (
    <span className={`inline-flex items-center rounded-lg border px-2.5 py-0.5 text-xs font-medium ${color}`}>
      {days}d
    </span>
  );
}

const MODES: { id: GenerateMode; label: string; desc: string }[] = [
  { id: "NEXT_30", label: "Next 30 days", desc: "Generate the next 30 days of classes" },
  { id: "NEXT_90", label: "Next 90 days", desc: "Generate the next 90 days of classes" },
  { id: "END_OF_YEAR", label: "Until end of year", desc: `Generate through Dec 31 ${new Date().getFullYear()}` },
  { id: "CUSTOM", label: "Custom date", desc: "Pick any future date as the target" },
];

export default function ScheduleGeneratorPage() {
  const { selectedStudioId, selected } = useDeskStudio();
  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  // Status
  const [status, setStatus] = useState<GeneratorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Generator form
  const [mode, setMode] = useState<GenerateMode>("NEXT_90");
  const [customDate, setCustomDate] = useState("");
  const [preview, setPreview] = useState<GenerationSummary | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<GenerationSummary | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  // Runs history
  const [runs, setRuns] = useState<GenerationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);

  // Automation
  const [automation, setAutomation] = useState<AutomationSettings | null>(null);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationFlash, setAutomationFlash] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!selectedStudioId || !canManage) return;
    setStatusLoading(true);
    setRunsLoading(true);
    try {
      const [s, r, a] = await Promise.all([
        fetchGeneratorStatus(selectedStudioId),
        fetchGenerationRuns(selectedStudioId),
        fetchAutomation(selectedStudioId),
      ]);
      setStatus(s);
      setRuns(r);
      setAutomation(a);
    } catch {
      // silently degrade — individual section errors shown inline
    } finally {
      setStatusLoading(false);
      setRunsLoading(false);
    }
  }, [selectedStudioId, canManage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handlePreview = async () => {
    if (!selectedStudioId) return;
    setPreviewing(true);
    setPreview(null);
    setGenResult(null);
    setGenError(null);
    try {
      const result = await previewGeneration(
        selectedStudioId,
        mode,
        mode === "CUSTOM" ? customDate : undefined,
      );
      setPreview(result);
    } catch (e) {
      setGenError(e instanceof ApiError ? e.message : "Preview failed.");
    } finally {
      setPreviewing(false);
    }
  };

  const handleGenerate = async () => {
    if (!selectedStudioId) return;
    setGenerating(true);
    setGenResult(null);
    setGenError(null);
    try {
      const result = await runGeneration(
        selectedStudioId,
        mode,
        mode === "CUSTOM" ? customDate : undefined,
      );
      setGenResult(result);
      setPreview(null);
      await reload();
    } catch (e) {
      setGenError(e instanceof ApiError ? e.message : "Generation failed.");
    } finally {
      setGenerating(false);
    }
  };

  const handleAutomationToggle = async (enabled: boolean) => {
    if (!selectedStudioId || !automation) return;
    setAutomationSaving(true);
    try {
      const next = await updateAutomation(selectedStudioId, {
        ...automation,
        enabled,
      });
      setAutomation(next);
      setAutomationFlash(enabled ? "Automation enabled" : "Automation disabled");
      window.setTimeout(() => setAutomationFlash(null), 2400);
    } catch {
      // no-op
    } finally {
      setAutomationSaving(false);
    }
  };

  const handleAutomationDaysSave = async () => {
    if (!selectedStudioId || !automation) return;
    setAutomationSaving(true);
    try {
      const next = await updateAutomation(selectedStudioId, automation);
      setAutomation(next);
      setAutomationFlash("Saved");
      window.setTimeout(() => setAutomationFlash(null), 2400);
    } catch {
      // no-op
    } finally {
      setAutomationSaving(false);
    }
  };

  if (!canManage) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h1 className="text-lg font-semibold text-zinc-100">Schedule Generator</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Only owners and admins can access the schedule generator.
        </p>
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <p className="text-sm text-zinc-500">Select a studio to manage schedule generation.</p>
    );
  }

  return (
    <div className="space-y-10 pb-16">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Schedule Generator</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-500">
          Generate future classes from your weekly schedule templates. Preview before committing.
          The generator never creates duplicates.
        </p>
      </header>

      {/* Coverage Status */}
      <SectionCard
        title="Current coverage"
        subtitle="How far ahead your schedule currently extends."
      >
        {statusLoading ? (
          <div className="space-y-2">
            <div className="h-4 w-48 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-32 animate-pulse rounded bg-zinc-800" />
          </div>
        ) : status ? (
          <div className="grid gap-6 sm:grid-cols-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Classes until</p>
              <p className="mt-1 text-xl font-semibold text-zinc-50">
                {status.lastClassDate
                  ? new Date(status.lastClassDate).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Future coverage</p>
              <p className="mt-1 flex items-center gap-2 text-xl font-semibold text-zinc-50">
                {status.futureDays} days
                <StatusPill days={status.futureDays} />
              </p>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Active templates</p>
              <p className="mt-1 text-xl font-semibold text-zinc-50">{status.templateCount}</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Could not load status.</p>
        )}
      </SectionCard>

      {/* Generator */}
      <SectionCard
        title="Generate classes"
        subtitle="Select a range, preview results, then generate."
      >
        <div className="space-y-5">
          {/* Mode selector */}
          <div className="grid gap-3 sm:grid-cols-2">
            {MODES.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors ${
                  mode === m.id
                    ? "border-violet-500/60 bg-violet-950/30"
                    : "border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.id}
                  checked={mode === m.id}
                  onChange={() => {
                    setMode(m.id);
                    setPreview(null);
                    setGenResult(null);
                    setGenError(null);
                  }}
                  className="mt-0.5 text-violet-600"
                />
                <span>
                  <span className="block text-sm font-medium text-zinc-100">{m.label}</span>
                  <span className="text-xs text-zinc-500">{m.desc}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Custom date picker */}
          {mode === "CUSTOM" && (
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Target date</span>
              <input
                type="date"
                className={INPUT}
                value={customDate}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setCustomDate(e.target.value)}
              />
            </label>
          )}

          {/* Error */}
          {genError && (
            <div className="rounded-xl border border-red-900/40 bg-red-950/15 px-4 py-3 text-sm text-red-200">
              {genError}
            </div>
          )}

          {/* Preview result */}
          {preview && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Preview</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-zinc-500">To generate</p>
                  <p className="text-2xl font-bold text-violet-400">{preview.generated}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Already exist</p>
                  <p className="text-2xl font-bold text-zinc-300">{preview.skipped}</p>
                </div>
                <div>
                  <p className="text-xs text-zinc-500">Conflicts</p>
                  <p className="text-2xl font-bold text-zinc-300">{preview.conflicts}</p>
                </div>
              </div>
              {Object.keys(preview.breakdown).length > 0 && (
                <div className="border-t border-zinc-800 pt-3">
                  <p className="mb-2 text-xs font-medium text-zinc-500">Breakdown</p>
                  <div className="space-y-1.5">
                    {Object.values(preview.breakdown).map((b) => (
                      <div key={b.name} className="flex items-center justify-between text-sm">
                        <span className="text-zinc-300">{b.name}</span>
                        <span className="text-zinc-500">
                          {b.generated > 0 && (
                            <span className="text-violet-400">{b.generated} new</span>
                          )}
                          {b.generated > 0 && b.skipped > 0 && (
                            <span className="text-zinc-700 mx-1">·</span>
                          )}
                          {b.skipped > 0 && (
                            <span>{b.skipped} skip</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Generation success */}
          {genResult && (
            <div className="rounded-xl border border-emerald-900/40 bg-emerald-950/20 px-4 py-3">
              <p className="text-sm font-semibold text-emerald-300">
                Generated {genResult.generated} classes
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                {genResult.skipped} already existed · {genResult.durationMs}ms
              </p>
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              disabled={previewing || generating || (mode === "CUSTOM" && !customDate)}
              onClick={() => void handlePreview()}
              className="rounded-xl border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:border-zinc-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {previewing ? "Previewing…" : "Preview"}
            </button>
            <button
              type="button"
              disabled={generating || previewing || (mode === "CUSTOM" && !customDate)}
              onClick={() => void handleGenerate()}
              className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      </SectionCard>

      {/* Automation */}
      {automation !== null && (
        <SectionCard
          title="Automation"
          subtitle="Automatically maintain future schedule coverage every night at 02:00 AM."
        >
          <div className="space-y-6">
            <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-zinc-800/60 p-4">
              <span>
                <span className="block text-sm font-medium text-zinc-100">
                  Automatically maintain future schedule
                </span>
                <span className="block mt-0.5 text-xs text-zinc-500">
                  Generates missing classes every night to keep the schedule at your minimum coverage.
                </span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 rounded border-zinc-600 bg-zinc-950 text-violet-600 focus:ring-violet-500/40"
                checked={automation.enabled}
                disabled={automationSaving}
                onChange={(e) => void handleAutomationToggle(e.target.checked)}
              />
            </label>

            {automation.enabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-zinc-400">
                    Minimum future coverage (days)
                  </span>
                  <input
                    type="number"
                    className={INPUT}
                    min={7}
                    max={365}
                    value={automation.minFutureDays}
                    onChange={(e) =>
                      setAutomation((a) =>
                        a ? { ...a, minFutureDays: Number(e.target.value) } : a,
                      )
                    }
                  />
                </label>
              </div>
            )}

            {automationFlash && (
              <p className="text-xs font-medium text-emerald-400">{automationFlash}</p>
            )}

            {automation.enabled && (
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={automationSaving}
                  onClick={() => void handleAutomationDaysSave()}
                  className="rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
                >
                  {automationSaving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
          </div>
        </SectionCard>
      )}

      {/* History */}
      <SectionCard
        title="Generation history"
        subtitle="Last 50 generation runs for this studio."
      >
        {runsLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-800" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-zinc-500">No generation runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                  <th className="pb-2 pr-4 font-medium">Date</th>
                  <th className="pb-2 pr-4 font-medium">Generated</th>
                  <th className="pb-2 pr-4 font-medium">Skipped</th>
                  <th className="pb-2 pr-4 font-medium">Duration</th>
                  <th className="pb-2 pr-4 font-medium">Trigger</th>
                  <th className="pb-2 font-medium">User</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-zinc-800/50 last:border-0">
                    <td className="py-3 pr-4 text-zinc-300">
                      {new Date(run.startedAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-3 pr-4 font-medium text-violet-400">{run.generated}</td>
                    <td className="py-3 pr-4 text-zinc-400">{run.skipped}</td>
                    <td className="py-3 pr-4 text-zinc-500">
                      {run.durationMs != null ? `${run.durationMs}ms` : "—"}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          run.triggeredBy === "AUTOMATIC"
                            ? "bg-zinc-800 text-zinc-400"
                            : "bg-violet-950/60 text-violet-300"
                        }`}
                      >
                        {run.triggeredBy.toLowerCase()}
                      </span>
                    </td>
                    <td className="py-3 text-zinc-500">
                      {run.user
                        ? `${run.user.firstName} ${run.user.lastName}`
                        : run.triggeredBy === "AUTOMATIC"
                          ? "System"
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
