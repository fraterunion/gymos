"use client";

import { useCallback, useEffect, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  archiveClassTemplate,
  createClassTemplate,
  fetchClassTemplates,
  updateClassTemplate,
  type ClassCategory,
  type ClassTemplateDto,
  type ClassTemplateInput,
  type IntensityLevel,
} from "@/lib/api/classTemplates";
import { fetchStaffInstructors, type StaffInstructorDto } from "@/lib/api/staff";

const COLOR_PRESETS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

const INTENSITY_OPTIONS: { value: IntensityLevel; label: string }[] = [
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "EXTREME", label: "Extreme" },
];

const CATEGORY_OPTIONS: { value: ClassCategory; label: string }[] = [
  { value: "STRENGTH", label: "Strength" },
  { value: "HIIT", label: "HIIT" },
  { value: "YOGA", label: "Yoga" },
  { value: "PILATES", label: "Pilates" },
  { value: "BOXING", label: "Boxing" },
  { value: "RUNNING", label: "Running" },
  { value: "RECOVERY", label: "Recovery" },
  { value: "MOBILITY", label: "Mobility" },
  { value: "CYCLING", label: "Cycling" },
  { value: "OTHER", label: "Other" },
];

const INTENSITY_COLORS: Record<IntensityLevel, string> = {
  LOW: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  MEDIUM: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  EXTREME: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const CATEGORY_COLORS: Record<ClassCategory, string> = {
  STRENGTH: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  HIIT: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  YOGA: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  PILATES: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  BOXING: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  RUNNING: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  RECOVERY: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  MOBILITY: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
  CYCLING: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  OTHER: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

type FormState = {
  name: string;
  description: string;
  durationMinutes: string;
  defaultCapacity: string;
  color: string;
  instructorId: string;
  intensityLevel: string;
  category: string;
  equipment: string;
  heroImageUrl: string;
  thumbnailImageUrl: string;
  tags: string;
  isFeatured: boolean;
  difficultyLabel: string;
  caloriesEstimateMin: string;
  caloriesEstimateMax: string;
  cancellationWindowHours: string;
  waitlistCapacity: string;
};

const emptyForm: FormState = {
  name: "",
  description: "",
  durationMinutes: "60",
  defaultCapacity: "10",
  color: "",
  instructorId: "",
  intensityLevel: "",
  category: "",
  equipment: "",
  heroImageUrl: "",
  thumbnailImageUrl: "",
  tags: "",
  isFeatured: false,
  difficultyLabel: "",
  caloriesEstimateMin: "",
  caloriesEstimateMax: "",
  cancellationWindowHours: "",
  waitlistCapacity: "",
};

function templateToForm(t: ClassTemplateDto): FormState {
  return {
    name: t.name,
    description: t.description ?? "",
    durationMinutes: String(t.durationMinutes),
    defaultCapacity: String(t.defaultCapacity),
    color: t.color ?? "",
    instructorId: t.defaultInstructorId ?? "",
    intensityLevel: t.intensityLevel ?? "",
    category: t.category ?? "",
    equipment: t.equipment.join(", "),
    heroImageUrl: t.heroImageUrl ?? "",
    thumbnailImageUrl: t.thumbnailImageUrl ?? "",
    tags: t.tags.join(", "),
    isFeatured: t.isFeatured,
    difficultyLabel: t.difficultyLabel ?? "",
    caloriesEstimateMin: t.caloriesEstimateMin !== null ? String(t.caloriesEstimateMin) : "",
    caloriesEstimateMax: t.caloriesEstimateMax !== null ? String(t.caloriesEstimateMax) : "",
    cancellationWindowHours: t.cancellationWindowHours !== null ? String(t.cancellationWindowHours) : "",
    waitlistCapacity: t.waitlistCapacity !== null ? String(t.waitlistCapacity) : "",
  };
}

function splitTags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function intOrNull(s: string): number | null {
  if (!s.trim()) return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

type ModalState = { type: "closed" } | { type: "create" } | { type: "edit"; template: ClassTemplateDto };

function TemplateModal({
  modal,
  instructors,
  studioId,
  onClose,
  onSaved,
}: {
  modal: Exclude<ModalState, { type: "closed" }>;
  instructors: StaffInstructorDto[];
  studioId: string;
  onClose: () => void;
  onSaved: (t: ClassTemplateDto) => void;
}) {
  const [form, setForm] = useState<FormState>(
    modal.type === "edit" ? templateToForm(modal.template) : emptyForm,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field =
    (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const input: ClassTemplateInput = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        durationMinutes: parseInt(form.durationMinutes, 10),
        defaultCapacity: parseInt(form.defaultCapacity, 10),
        color: form.color.trim() || null,
        instructorId: form.instructorId || null,
        intensityLevel: (form.intensityLevel as IntensityLevel) || null,
        category: (form.category as ClassCategory) || null,
        equipment: splitTags(form.equipment),
        heroImageUrl: form.heroImageUrl.trim() || null,
        thumbnailImageUrl: form.thumbnailImageUrl.trim() || null,
        tags: splitTags(form.tags),
        isFeatured: form.isFeatured,
        difficultyLabel: form.difficultyLabel.trim() || null,
        caloriesEstimateMin: intOrNull(form.caloriesEstimateMin),
        caloriesEstimateMax: intOrNull(form.caloriesEstimateMax),
        cancellationWindowHours: intOrNull(form.cancellationWindowHours),
        waitlistCapacity: intOrNull(form.waitlistCapacity),
      };
      const saved =
        modal.type === "edit"
          ? await updateClassTemplate(studioId, modal.template.id, input)
          : await createClassTemplate(studioId, input);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save class type");
    } finally {
      setSaving(false);
    }
  };

  const labelCls = "block text-xs font-medium text-zinc-700 dark:text-zinc-300";
  const inputCls =
    "mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm sm:items-start sm:pt-16"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {modal.type === "edit" ? "Edit class type" : "New class type"}
        </h2>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-5">
          {/* Core */}
          <div>
            <label className={labelCls}>Name</label>
            <input
              type="text"
              required
              maxLength={200}
              value={form.name}
              onChange={field("name")}
              placeholder="e.g. Yoga Flow"
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <textarea
              rows={2}
              maxLength={2000}
              value={form.description}
              onChange={field("description")}
              placeholder="Optional"
              className={inputCls}
            />
          </div>

          {/* Duration / Capacity */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Duration (min)</label>
              <input
                type="number"
                required
                min={1}
                max={1440}
                value={form.durationMinutes}
                onChange={field("durationMinutes")}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Default capacity</label>
              <input
                type="number"
                required
                min={1}
                max={10000}
                value={form.defaultCapacity}
                onChange={field("defaultCapacity")}
                className={inputCls}
              />
            </div>
          </div>

          {/* Category / Intensity */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Category</label>
              <select value={form.category} onChange={field("category")} className={inputCls}>
                <option value="">— None —</option>
                {CATEGORY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Intensity</label>
              <select value={form.intensityLevel} onChange={field("intensityLevel")} className={inputCls}>
                <option value="">— None —</option>
                {INTENSITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Difficulty label / Featured */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Difficulty label</label>
              <input
                type="text"
                maxLength={100}
                value={form.difficultyLabel}
                onChange={field("difficultyLabel")}
                placeholder="e.g. Beginner-friendly"
                className={inputCls}
              />
            </div>
            <div className="flex items-end pb-0.5">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                <input
                  type="checkbox"
                  checked={form.isFeatured}
                  onChange={(e) => setForm((prev) => ({ ...prev, isFeatured: e.target.checked }))}
                  className="h-4 w-4 rounded border-zinc-300 accent-zinc-900 dark:border-zinc-600"
                />
                Featured class
              </label>
            </div>
          </div>

          {/* Calories */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Calories estimate min</label>
              <input
                type="number"
                min={1}
                max={10000}
                value={form.caloriesEstimateMin}
                onChange={field("caloriesEstimateMin")}
                placeholder="e.g. 300"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Calories estimate max</label>
              <input
                type="number"
                min={1}
                max={10000}
                value={form.caloriesEstimateMax}
                onChange={field("caloriesEstimateMax")}
                placeholder="e.g. 500"
                className={inputCls}
              />
            </div>
          </div>

          {/* Cancellation / Waitlist */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Cancellation window (hours)</label>
              <input
                type="number"
                min={0}
                max={168}
                value={form.cancellationWindowHours}
                onChange={field("cancellationWindowHours")}
                placeholder="Overrides studio default"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Waitlist capacity</label>
              <input
                type="number"
                min={0}
                max={10000}
                value={form.waitlistCapacity}
                onChange={field("waitlistCapacity")}
                placeholder="e.g. 5"
                className={inputCls}
              />
            </div>
          </div>

          {/* Instructor */}
          <div>
            <label className={labelCls}>Default instructor</label>
            <select
              value={form.instructorId}
              onChange={field("instructorId")}
              className={inputCls}
            >
              <option value="">— None —</option>
              {instructors.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.firstName} {m.lastName} · {m.staffType}
                </option>
              ))}
            </select>
          </div>

          {/* Equipment / Tags */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Equipment (comma-separated)</label>
              <input
                type="text"
                value={form.equipment}
                onChange={field("equipment")}
                placeholder="e.g. Dumbbells, Mat"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Tags (comma-separated)</label>
              <input
                type="text"
                value={form.tags}
                onChange={field("tags")}
                placeholder="e.g. core, cardio"
                className={inputCls}
              />
            </div>
          </div>

          {/* Images */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Hero image URL</label>
              <input
                type="url"
                maxLength={500}
                value={form.heroImageUrl}
                onChange={field("heroImageUrl")}
                placeholder="https://…"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Thumbnail image URL</label>
              <input
                type="url"
                maxLength={500}
                value={form.thumbnailImageUrl}
                onChange={field("thumbnailImageUrl")}
                placeholder="https://…"
                className={inputCls}
              />
            </div>
          </div>

          {/* Color */}
          <div>
            <label className={labelCls}>Color</label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, color: c }))}
                  style={{ backgroundColor: c }}
                  className={`h-6 w-6 rounded-full transition ${
                    form.color === c
                      ? "ring-2 ring-zinc-900 ring-offset-1 dark:ring-zinc-100"
                      : "opacity-70 hover:opacity-100"
                  }`}
                />
              ))}
              <input
                type="text"
                maxLength={32}
                value={form.color}
                onChange={field("color")}
                placeholder="#hex"
                className="w-24 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
              {form.color ? (
                <span
                  className="h-6 w-6 rounded-full border border-zinc-200 dark:border-zinc-700"
                  style={{ backgroundColor: form.color }}
                />
              ) : null}
            </div>
          </div>

          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {saving ? "Saving…" : modal.type === "edit" ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function ClassesPage() {
  const { selectedStudioId, loading: studioLoading, error: studioError } = useDeskStudio();
  const [templates, setTemplates] = useState<ClassTemplateDto[]>([]);
  const [instructors, setInstructors] = useState<StaffInstructorDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: "closed" });
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedStudioId) {
      setTemplates([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [tpl, instr] = await Promise.all([
        fetchClassTemplates(selectedStudioId),
        fetchStaffInstructors(selectedStudioId),
      ]);
      setTemplates(tpl);
      setInstructors(instr);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load class types");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const handleSaved = (saved: ClassTemplateDto) => {
    setTemplates((prev) => {
      const idx = prev.findIndex((t) => t.id === saved.id);
      if (idx === -1) return [saved, ...prev];
      const next = [...prev];
      next[idx] = saved;
      return next;
    });
    setModal({ type: "closed" });
  };

  const handleArchive = async (template: ClassTemplateDto) => {
    if (!selectedStudioId) return;
    setArchivingId(template.id);
    setError(null);
    try {
      await archiveClassTemplate(selectedStudioId, template.id);
      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not archive class type");
    } finally {
      setArchivingId(null);
    }
  };

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No studio memberships found for this account.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Class types
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Reusable templates for scheduling. Changes here affect future scheduled classes only.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setModal({ type: "create" })}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            New type
          </button>
        </div>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100">
            {error}
            <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-44 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/50"
              />
            ))}
          </div>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 px-6 py-16 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No class types yet</p>
            <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
              Create a class type to start scheduling classes for your studio.
            </p>
            <button
              type="button"
              onClick={() => setModal({ type: "create" })}
              className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Create first class type
            </button>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <li key={t.id}>
                <div className="flex flex-col rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900 overflow-hidden">
                  {t.thumbnailImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={t.thumbnailImageUrl}
                      alt=""
                      className="h-28 w-full object-cover"
                    />
                  ) : null}
                  <div className="p-5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        {t.color ? (
                          <span
                            className="mt-0.5 h-3 w-3 shrink-0 rounded-full"
                            style={{ backgroundColor: t.color }}
                          />
                        ) : null}
                        <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">
                          {t.name}
                        </h2>
                        {t.isFeatured ? (
                          <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                            Featured
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => setModal({ type: "edit", template: t })}
                          className="rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={archivingId === t.id}
                          onClick={() => void handleArchive(t)}
                          className="rounded-md px-2 py-1 text-xs font-medium text-zinc-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:text-zinc-500 dark:hover:bg-red-950/30 dark:hover:text-red-400"
                        >
                          {archivingId === t.id ? "…" : "Archive"}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {t.category ? (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CATEGORY_COLORS[t.category]}`}>
                          {CATEGORY_OPTIONS.find((o) => o.value === t.category)?.label ?? t.category}
                        </span>
                      ) : null}
                      {t.intensityLevel ? (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${INTENSITY_COLORS[t.intensityLevel]}`}>
                          {INTENSITY_OPTIONS.find((o) => o.value === t.intensityLevel)?.label ?? t.intensityLevel}
                        </span>
                      ) : null}
                      {t.difficultyLabel ? (
                        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                          {t.difficultyLabel}
                        </span>
                      ) : null}
                    </div>

                    {t.description ? (
                      <p className="mt-2 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                        {t.description}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400 dark:text-zinc-500">
                      <span>{t.durationMinutes} min</span>
                      <span>·</span>
                      <span>Cap {t.defaultCapacity}</span>
                      {t.caloriesEstimateMin !== null || t.caloriesEstimateMax !== null ? (
                        <>
                          <span>·</span>
                          <span>
                            {t.caloriesEstimateMin ?? "?"}–{t.caloriesEstimateMax ?? "?"} kcal
                          </span>
                        </>
                      ) : null}
                      {t.defaultInstructor ? (
                        <>
                          <span>·</span>
                          <span>
                            {t.defaultInstructor.firstName} {t.defaultInstructor.lastName}
                          </span>
                        </>
                      ) : null}
                    </div>
                    {t.tags.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {t.tags.slice(0, 4).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                          >
                            {tag}
                          </span>
                        ))}
                        {t.tags.length > 4 ? (
                          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            +{t.tags.length - 4}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {modal.type !== "closed" && selectedStudioId ? (
        <TemplateModal
          modal={modal as Exclude<ModalState, { type: "closed" }>}
          instructors={instructors}
          studioId={selectedStudioId}
          onClose={() => setModal({ type: "closed" })}
          onSaved={handleSaved}
        />
      ) : null}
    </>
  );
}
