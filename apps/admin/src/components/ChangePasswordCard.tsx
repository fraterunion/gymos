"use client";

import { useCallback, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { ApiError } from "@/lib/api/errors";
import { adminInput, adminPrimaryBtn } from "@/lib/adminSurface";

/**
 * Account security card (Settings → Security). The credential belongs to the user, not to
 * the studio, so this is available to any signed-in staff member regardless of role.
 *
 * On success the server revokes every session and returns fresh credentials for THIS
 * browser, which the auth context adopts — the user stays signed in here and is signed out
 * everywhere else. The copy states that plainly.
 */

const MIN_PASSWORD_LENGTH = 8;

export function ChangePasswordCard() {
  const { changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setDone(false);
      if (!currentPassword) {
        setError("Enter your current password.");
        return;
      }
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (newPassword === currentPassword) {
        setError("The new password must be different from the current one.");
        return;
      }
      if (newPassword !== confirm) {
        setError("The passwords do not match.");
        return;
      }
      setBusy(true);
      try {
        await changePassword(currentPassword, newPassword);
        setDone(true);
        setCurrentPassword("");
        setNewPassword("");
        setConfirm("");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setError("The current password is incorrect.");
        } else if (err instanceof ApiError && err.status === 400) {
          setError(err.message);
        } else if (err instanceof ApiError && err.status === 429) {
          setError("Too many attempts. Wait a few minutes and try again.");
        } else {
          setError("Could not update your password. Check your connection and try again.");
        }
      } finally {
        setBusy(false);
      }
    },
    [changePassword, currentPassword, newPassword, confirm],
  );

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-6">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-900">Security</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Change your password. Your other devices will be signed out.
        </p>
      </div>

      <form onSubmit={(e) => void onSubmit(e)} className="grid gap-4 sm:max-w-md">
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            className={adminInput}
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            className={adminInput}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-zinc-600">
            Confirm new password
          </span>
          <input
            type="password"
            autoComplete="new-password"
            className={adminInput}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>

        {error ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {error}
          </p>
        ) : null}
        {done ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
            Password updated. Your other devices were signed out.
          </p>
        ) : null}

        <div>
          <button type="submit" disabled={busy} className={adminPrimaryBtn}>
            {busy ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </section>
  );
}
