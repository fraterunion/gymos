"use client";

import { useCallback, useEffect, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  archiveClassTemplate,
  createClassTemplate,
  fetchClassTemplates,
  updateClassTemplate,
  type ClassTemplateDto,
  type ClassTemplateInput,
} from "@/lib/api/classTemplates";
import { fetchStudioMembers, type MemberDto } from "@/lib/api/members";

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

type FormState = {
  name: string;
  description: string;
  durationMinutes: string;
  defaultCapacity: string;
  color: string;
  instructorId: string;
};

const emptyForm: FormState = {
  name: "",
  description: "",
  durationMinutes: "60",
  defaultCapacity: "10",
  color: "",
  instructorId: "",
};

function templateToForm(t: ClassTemplateDto): FormState {
  return {
    name: t.name,
    description: t.description ?? "",
    durationMinutes: String(t.durationMinutes),
    defaultCapacity: String(t.defaultCapacity),
    color: t.color ?? "",
    instructorId: t.defaultInstructorId ?? "",
  };
}

type ModalState = { type: "closed" } | { type: "create" } | { type: "edit"; template: ClassTemplateDto };

function TemplateModal({
  modal,
  members,
  studioId,
  onClose,
  onSaved,
}: {
  modal: Exclude<ModalState, { type: "closed" }>;
  members: MemberDto[];
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {modal.type === "edit" ? "Edit class type" : "New class type"}
        </h2>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">Name</label>
            <input
              type="text"
              required
              maxLength={200}
              value={form.name}
              onChange={field("name")}
              placeholder="e.g. Yoga Flow"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">Description</label>
            <textarea
              rows={2}
              maxLength={2000}
              value={form.description}
              onChange={field("description")}
              placeholder="Optional"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Duration (min)
              </label>
              <input
                type="number"
                required
                min={1}
                max={1440}
                value={form.durationMinutes}
                onChange={field("durationMinutes")}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Default capacity
              </label>
              <input
                type="number"
                required
                min={1}
                max={10000}
                value={form.defaultCapacity}
                onChange={field("defaultCapacity")}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Default instructor
            </label>
            <select
              value={form.instructorId}
              onChange={field("instructorId")}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
            >
              <option value="">— None —</option>
              {members.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.firstName} {m.user.lastName} · {m.role}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">Color</label>
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
  const [members, setMembers] = useState<MemberDto[]>([]);
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
      const [tpl, mem] = await Promise.all([
        fetchClassTemplates(selectedStudioId),
        fetchStudioMembers(selectedStudioId),
      ]);
      setTemplates(tpl);
      setMembers(mem);
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
                className="h-36 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/50"
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
                <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
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
                  {t.description ? (
                    <p className="mt-2 line-clamp-2 text-sm text-zinc-500 dark:text-zinc-400">
                      {t.description}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-400 dark:text-zinc-500">
                    <span>{t.durationMinutes} min</span>
                    <span>·</span>
                    <span>Cap {t.defaultCapacity}</span>
                    {t.defaultInstructor ? (
                      <>
                        <span>·</span>
                        <span>
                          {t.defaultInstructor.firstName} {t.defaultInstructor.lastName}
                        </span>
                      </>
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
          members={members}
          studioId={selectedStudioId}
          onClose={() => setModal({ type: "closed" })}
          onSaved={handleSaved}
        />
      ) : null}
    </>
  );
}
