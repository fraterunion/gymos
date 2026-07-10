"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  addStaffMember,
  deactivateStaffMember,
  fetchStaff,
  updateStaffMember,
  type AddStaffInput,
  type StaffListQuery,
  type StaffMember,
  type StaffRole,
  type StaffType,
  type UpdateStaffInput,
} from "@/lib/api/staff";

// ── Constants ────────────────────────────────────────────────────────────────

const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  COACH: "Coach",
  FRONT_DESK: "Front Desk",
  MANAGER: "Manager",
  OPERATIONS: "Operations",
  OTHER: "Other",
};

const STAFF_TYPE_COLORS: Record<StaffType, string> = {
  COACH: "bg-blue-100 text-blue-800",
  FRONT_DESK: "bg-violet-100 text-violet-800",
  MANAGER: "bg-amber-100 text-amber-800",
  OPERATIONS: "bg-emerald-100 text-emerald-800",
  OTHER: "bg-zinc-100 text-zinc-600",
};

const ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  STAFF: "Staff",
  INSTRUCTOR: "Instructor",
  FRONT_DESK: "Front desk",
};

const ROLE_COLORS: Record<StaffRole, string> = {
  OWNER: "bg-amber-100 text-amber-900",
  ADMIN: "bg-violet-100 text-violet-800",
  STAFF: "bg-teal-100 text-teal-800",
  INSTRUCTOR: "bg-sky-100 text-sky-800",
  FRONT_DESK: "bg-emerald-100 text-emerald-800",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function initials(first: string, last: string) {
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function secureRandomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % max;
}

/** 12–16 chars with uppercase, lowercase, digit, and symbol. */
function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const length = 12 + secureRandomInt(5);
  const all = upper + lower + digits + symbols;

  const chars = [
    upper[secureRandomInt(upper.length)]!,
    lower[secureRandomInt(lower.length)]!,
    digits[secureRandomInt(digits.length)]!,
    symbols[secureRandomInt(symbols.length)]!,
    ...Array.from({ length: length - 4 }, () => all[secureRandomInt(all.length)]!),
  ];

  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join("");
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function RowSkeleton() {
  return (
    <tr className="border-b border-zinc-100">
      {[...Array(6)].map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div
            className="h-4 animate-pulse rounded bg-zinc-200"
            style={{ width: `${50 + (i * 19) % 40}%` }}
          />
        </td>
      ))}
    </tr>
  );
}

// ── Add Staff Modal ───────────────────────────────────────────────────────────

function AddStaffModal({
  studioId,
  canCreateAdmin,
  onClose,
  onDone,
}: {
  studioId: string;
  canCreateAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<AddStaffInput>({
    email: "",
    firstName: "",
    lastName: "",
    role: "STAFF",
    staffType: "COACH",
    phone: "",
    bio: "",
    specialties: [],
    isActive: true,
  });
  const [specialtiesInput, setSpecialtiesInput] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const pwd = temporaryPassword.trim();
    if (pwd.length < 8 || pwd.length > 128) {
      setError("Temporary password must be between 8 and 128 characters.");
      return;
    }

    setSaving(true);
    try {
      const payload: AddStaffInput = {
        email: form.email.trim(),
        role: form.role,
        staffType: form.role === "INSTRUCTOR" ? "COACH" : form.staffType,
        isActive: form.isActive,
        temporaryPassword: pwd,
      };
      if (form.firstName?.trim()) payload.firstName = form.firstName.trim();
      if (form.lastName?.trim()) payload.lastName = form.lastName.trim();
      if (form.phone?.trim()) payload.phone = form.phone.trim();
      if (form.bio?.trim()) payload.bio = form.bio.trim();
      const specs = specialtiesInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (specs.length) payload.specialties = specs;
      await addStaffMember(studioId, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add staff member");
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
        className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-900">Add staff member</h2>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Email <span className="text-red-500">*</span>
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="coach@example.com"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <p className="text-xs text-zinc-500">
            If no account exists with this email, fill in name below to create one. Set a temporary
            password so this team member can sign in immediately.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700">
                First name
              </label>
              <input
                type="text"
                value={form.firstName ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700">
                Last name
              </label>
              <input
                type="text"
                value={form.lastName ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Temporary password <span className="text-red-500">*</span>
            </label>
            <div className="mt-1 flex gap-2">
              <input
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                maxLength={128}
                value={temporaryPassword}
                onChange={(e) => setTemporaryPassword(e.target.value)}
                placeholder="Set a temporary password"
                autoComplete="new-password"
                className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                {showPassword ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={() => setTemporaryPassword(generateTemporaryPassword())}
                className="shrink-0 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50"
              >
                Generate
              </button>
            </div>
            <p className="mt-1.5 text-xs text-zinc-500">
              Share this password securely with the team member. It cannot be recovered later.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-700">
                Role <span className="text-red-500">*</span>
              </label>
              <select
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value as AddStaffInput["role"];
                  setForm((f) => ({
                    ...f,
                    role,
                    staffType:
                      role === "INSTRUCTOR"
                        ? "COACH"
                        : role === "FRONT_DESK"
                          ? "FRONT_DESK"
                          : f.staffType,
                  }));
                }}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                <option value="STAFF">Staff</option>
                <option value="FRONT_DESK">Front desk</option>
                <option value="INSTRUCTOR">Coach / Instructor</option>
                {canCreateAdmin ? <option value="ADMIN">Admin</option> : null}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700">
                Type <span className="text-red-500">*</span>
              </label>
              {form.role === "INSTRUCTOR" ? (
                <input
                  type="text"
                  readOnly
                  value="Coach"
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 shadow-sm"
                />
              ) : (
              <select
                value={form.staffType}
                onChange={(e) => setForm((f) => ({ ...f, staffType: e.target.value as StaffType }))}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                {(Object.keys(STAFF_TYPE_LABELS) as StaffType[]).map((t) => (
                  <option key={t} value={t}>{STAFF_TYPE_LABELS[t]}</option>
                ))}
              </select>
              )}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Phone
            </label>
            <input
              type="tel"
              value={form.phone ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Bio
            </label>
            <textarea
              rows={2}
              value={form.bio ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Specialties <span className="font-normal text-zinc-400">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={specialtiesInput}
              onChange={(e) => setSpecialtiesInput(e.target.value)}
              placeholder="e.g. HIIT, Yoga, Strength"
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.isActive ?? true}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded border-zinc-300"
            />
            <span className="text-sm text-zinc-700">Active</span>
          </label>
          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "Adding…" : "Add member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Staff Modal ──────────────────────────────────────────────────────────

function EditStaffModal({
  studioId,
  member,
  onClose,
  onDone,
}: {
  studioId: string;
  member: StaffMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<UpdateStaffInput>({
    role: member.role === "OWNER" ? undefined : (member.role as "ADMIN" | "STAFF"),
    staffType: member.staffProfile?.staffType ?? "OTHER",
    phone: member.staffProfile?.phone ?? "",
    bio: member.staffProfile?.bio ?? "",
    specialties: member.staffProfile?.specialties ?? [],
    photoUrl: member.staffProfile?.photoUrl ?? "",
    isActive: member.staffProfile?.isActive ?? true,
  });
  const [specialtiesInput, setSpecialtiesInput] = useState(
    (member.staffProfile?.specialties ?? []).join(", "),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOwner = member.role === "OWNER";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload: UpdateStaffInput = {};
      if (form.role !== undefined) payload.role = form.role;
      if (form.staffType !== undefined) payload.staffType = form.staffType;
      if (form.phone !== undefined) payload.phone = form.phone?.trim() || undefined;
      if (form.bio !== undefined) payload.bio = form.bio?.trim() || undefined;
      const specs = specialtiesInput.split(",").map((s) => s.trim()).filter(Boolean);
      payload.specialties = specs;
      if (form.photoUrl !== undefined) payload.photoUrl = form.photoUrl?.trim() || undefined;
      payload.isActive = form.isActive;
      await updateStaffMember(studioId, member.userId, payload);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update staff member");
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
        className="w-full max-w-lg rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-sm font-semibold text-zinc-700">
            {initials(member.user.firstName, member.user.lastName)}
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-900">
              {member.user.firstName} {member.user.lastName}
            </h2>
            <p className="text-xs text-zinc-500">{member.user.email}</p>
          </div>
        </div>
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {!isOwner ? (
              <div>
                <label className="block text-xs font-medium text-zinc-700">Role</label>
                <select
                  value={form.role ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as "ADMIN" | "STAFF" }))}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
                >
                  <option value="STAFF">Staff</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-zinc-500">Role</p>
                <p className="mt-1 text-sm font-semibold text-amber-700">Owner</p>
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-zinc-700">Type</label>
              <select
                value={form.staffType ?? "OTHER"}
                onChange={(e) => setForm((f) => ({ ...f, staffType: e.target.value as StaffType }))}
                className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
              >
                {(Object.keys(STAFF_TYPE_LABELS) as StaffType[]).map((t) => (
                  <option key={t} value={t}>{STAFF_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">Phone</label>
            <input
              type="tel"
              value={form.phone ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">Bio</label>
            <textarea
              rows={2}
              value={form.bio ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">
              Specialties <span className="font-normal text-zinc-400">(comma-separated)</span>
            </label>
            <input
              type="text"
              value={specialtiesInput}
              onChange={(e) => setSpecialtiesInput(e.target.value)}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700">Photo URL</label>
            <input
              type="url"
              value={form.photoUrl ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, photoUrl: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={form.isActive ?? true}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="rounded border-zinc-300"
            />
            <span className="text-sm text-zinc-700">Active</span>
          </label>
          {error ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Deactivate Confirm Modal ──────────────────────────────────────────────────

function DeactivateModal({
  studioId,
  member,
  onClose,
  onDone,
}: {
  studioId: string;
  member: StaffMember;
  onClose: () => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await deactivateStaffMember(studioId, member.userId);
      if (result.futureClassesCount > 0) {
        // Still proceed — just informational
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not deactivate staff member");
    } finally {
      setLoading(false);
    }
  };

  const isAlreadyInactive = member.staffProfile?.isActive === false;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-900">
          Deactivate {member.user.firstName} {member.user.lastName}?
        </h2>
        <p className="mt-2 text-sm text-zinc-600">
          This will mark them as inactive. They will no longer appear in the instructor dropdown for new classes. Historical classes are preserved.
        </p>
        {member.assignedClassesCount > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Warning: this instructor has {member.assignedClassesCount} upcoming scheduled{" "}
            {member.assignedClassesCount === 1 ? "class" : "classes"}. Those classes will retain the instructor assignment but the instructor will not be selectable for new classes.
          </div>
        ) : null}
        {isAlreadyInactive ? (
          <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            This staff member is already inactive.
          </div>
        ) : null}
        {error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading || isAlreadyInactive}
            onClick={() => void handle()}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
          >
            {loading ? "Deactivating…" : "Confirm deactivate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Staff Row ─────────────────────────────────────────────────────────────────

function StaffRow({
  member,
  onEdit,
  onDeactivate,
}: {
  member: StaffMember;
  onEdit: (m: StaffMember) => void;
  onDeactivate: (m: StaffMember) => void;
}) {
  const profile = member.staffProfile;
  const isActive = profile ? profile.isActive : true;

  return (
    <tr className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          {profile?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.photoUrl}
              alt=""
              className="h-8 w-8 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-700">
              {initials(member.user.firstName, member.user.lastName)}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900">
              {member.user.firstName} {member.user.lastName}
            </p>
            <p className="truncate text-xs text-zinc-500">{member.user.email}</p>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ROLE_COLORS[member.role]}`}
        >
          {ROLE_LABELS[member.role]}
        </span>
      </td>
      <td className="px-4 py-3">
        {profile ? (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STAFF_TYPE_COLORS[profile.staffType]}`}
          >
            {STAFF_TYPE_LABELS[profile.staffType]}
          </span>
        ) : (
          <span className="text-xs text-zinc-400">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            isActive
              ? "bg-emerald-100 text-emerald-800"
              : "bg-zinc-100 text-zinc-500"
          }`}
        >
          {isActive ? "Active" : "Inactive"}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-zinc-600">
        {member.assignedClassesCount > 0 ? (
          <span className="font-medium text-zinc-800">
            {member.assignedClassesCount}
          </span>
        ) : (
          <span className="text-zinc-400">0</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-zinc-500">
        {fmtDate(member.joinedAt)}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onEdit(member)}
            className="rounded-lg px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            Edit
          </button>
          {member.role !== "OWNER" ? (
            <button
              type="button"
              onClick={() => onDeactivate(member)}
              className={`rounded-lg px-2 py-1 text-xs font-medium ${
                isActive
                  ? "text-red-600 hover:bg-red-50 hover:text-red-700"
                  : "text-zinc-400 hover:bg-zinc-100"
              }`}
            >
              {isActive ? "Deactivate" : "Reactivate"}
            </button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function StaffPage() {
  const { selectedStudioId, selected, loading: studioLoading, error: studioError } = useDeskStudio();

  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState<StaffRole | "">("");
  const [filterType, setFilterType] = useState<StaffType | "">("");
  const [filterActive, setFilterActive] = useState<"" | "true" | "false">("");

  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<StaffMember | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
    };
  }, [search]);

  const load = useCallback(async () => {
    if (!selectedStudioId) {
      setStaff([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query: StaffListQuery = { limit: 100 };
      if (debouncedSearch) query.search = debouncedSearch;
      if (filterRole) query.role = filterRole;
      if (filterType) query.staffType = filterType;
      if (filterActive !== "") query.isActive = filterActive === "true";
      const res = await fetchStaff(selectedStudioId, query);
      setStaff(res.data);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load staff");
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, debouncedSearch, filterRole, filterType, filterActive]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const handleDone = () => {
    setShowAdd(false);
    setEditTarget(null);
    setDeactivateTarget(null);
    void load();
  };

  const handleAddDone = () => {
    setShowAdd(false);
    setSuccessMessage(
      "Team account created. Share the temporary password securely — it cannot be viewed again.",
    );
    void load();
  };

  const handleDeactivateClick = (member: StaffMember) => {
    // If already inactive, use edit modal to reactivate via isActive toggle
    if (member.staffProfile?.isActive === false) {
      setEditTarget(member);
      return;
    }
    setDeactivateTarget(member);
  };

  if (studioLoading) {
    return <p className="text-sm text-zinc-500">Loading studios…</p>;
  }

  if (studioError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-800">
        {studioError}
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center">
        <p className="text-sm text-zinc-600">No studio memberships found.</p>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              Staff
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              {loading ? "Loading…" : `${total} team member${total !== 1 ? "s" : ""}`}
            </p>
          </div>
          {canManage ? (
            <button
              type="button"
              onClick={() => {
                setSuccessMessage(null);
                setShowAdd(true);
              }}
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
            >
              + Add staff member
            </button>
          ) : null}
        </div>

        {successMessage ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            {successMessage}
            <button
              type="button"
              className="ml-3 font-semibold underline"
              onClick={() => setSuccessMessage(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            placeholder="Search name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          <select
            value={filterRole}
            onChange={(e) => setFilterRole(e.target.value as StaffRole | "")}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            <option value="">All roles</option>
            <option value="OWNER">Owner</option>
            <option value="ADMIN">Admin</option>
            <option value="STAFF">Staff</option>
            <option value="FRONT_DESK">Front desk</option>
            <option value="INSTRUCTOR">Instructor</option>
          </select>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as StaffType | "")}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            <option value="">All types</option>
            {(Object.keys(STAFF_TYPE_LABELS) as StaffType[]).map((t) => (
              <option key={t} value={t}>{STAFF_TYPE_LABELS[t]}</option>
            ))}
          </select>
          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value as "" | "true" | "false")}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-700 shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
          >
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
        </div>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
            <button type="button" className="ml-3 font-semibold underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : null}

        {/* Table */}
        <div className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full min-w-[700px] text-left">
            <thead>
              <tr className="border-b border-zinc-100">
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Member
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Role
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Type
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Classes
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Joined
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <>
                  <RowSkeleton />
                  <RowSkeleton />
                  <RowSkeleton />
                </>
              ) : staff.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <p className="text-sm font-medium text-zinc-500">
                      {debouncedSearch || filterRole || filterType || filterActive
                        ? "No staff match your filters."
                        : "No staff added yet."}
                    </p>
                    {!debouncedSearch && !filterRole && !filterType && !filterActive && canManage ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSuccessMessage(null);
                          setShowAdd(true);
                        }}
                        className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                      >
                        Add first staff member
                      </button>
                    ) : null}
                  </td>
                </tr>
              ) : (
                staff.map((m) => (
                  <StaffRow
                    key={m.membershipId}
                    member={m}
                    onEdit={setEditTarget}
                    onDeactivate={handleDeactivateClick}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && selectedStudioId ? (
        <AddStaffModal
          studioId={selectedStudioId}
          canCreateAdmin={selected?.role === "OWNER"}
          onClose={() => setShowAdd(false)}
          onDone={handleAddDone}
        />
      ) : null}

      {editTarget && selectedStudioId ? (
        <EditStaffModal
          studioId={selectedStudioId}
          member={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={handleDone}
        />
      ) : null}

      {deactivateTarget && selectedStudioId ? (
        <DeactivateModal
          studioId={selectedStudioId}
          member={deactivateTarget}
          onClose={() => setDeactivateTarget(null)}
          onDone={handleDone}
        />
      ) : null}
    </>
  );
}
