"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";

import { DeskQrScanner } from "@/components/DeskQrScanner";
import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import { checkInWithQr } from "@/lib/api/checkIns";

function friendlyCheckInError(e: unknown): string {
  if (e instanceof TypeError) {
    return "Network error. Check your connection and try again.";
  }
  if (e instanceof ApiError) {
    const m = e.message.toLowerCase();
    if (m.includes("already checked in")) return "This member is already checked in.";
    if (m.includes("qr token already used") || m.includes("expired")) {
      return "That code was already used or has expired. Ask the member to refresh their code.";
    }
    if (m.includes("invalid") && m.includes("token")) {
      return "That code could not be read. Ask the member to show a fresh code.";
    }
    if (m.includes("outside") || m.includes("window")) {
      return "Check-in is outside the allowed time window for this class.";
    }
    if (e.status === 403) return "You are not allowed to perform this check-in.";
    return e.message;
  }
  return "Something went wrong.";
}

export default function ScanPage() {
  const { selectedStudioId, loading: studioLoading, error: studioError } = useDeskStudio();
  const studioId = selectedStudioId ?? "";

  const [qrText, setQrText] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const submitQrLockRef = useRef(false);
  const [flash, setFlash] = useState<{ type: "ok" | "warn" | "err"; text: string } | null>(null);

  const submitQrToken = useCallback(
    async (raw: string, options?: { clearPasteField?: boolean }): Promise<{ success: boolean }> => {
      const trimmed = raw.trim();
      if (!studioId || !trimmed) return { success: false };
      if (submitQrLockRef.current) return { success: false };
      submitQrLockRef.current = true;
      setQrBusy(true);
      setFlash(null);
      try {
        const row = await checkInWithQr(studioId, trimmed);
        if (options?.clearPasteField !== false) setQrText("");
        setFlash({
          type: "ok",
          text: `Check-in confirmado: ${row.user.firstName} ${row.user.lastName}.`,
        });
        return { success: true };
      } catch (e) {
        const msg = friendlyCheckInError(e);
        setFlash({ type: e instanceof ApiError && e.status === 409 ? "warn" : "err", text: msg });
        return { success: false };
      } finally {
        submitQrLockRef.current = false;
        setQrBusy(false);
      }
    },
    [studioId],
  );

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

  if (!studioId) {
    return (
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">No studio memberships found for this account.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">QR Scanner</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Escanea el código del miembro para registrar su check-in. También puedes abrir una clase en{" "}
          <Link href="/check-in" className="font-medium text-zinc-800 underline dark:text-zinc-200">
            Today&apos;s Classes
          </Link>
          .
        </p>
      </div>

      {flash ? (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-100"
              : flash.type === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-100"
                : "border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-100"
          }`}
        >
          {flash.text}
        </div>
      ) : null}

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-inner dark:border-zinc-700">
          <DeskQrScanner enabled={Boolean(studioId)} onScan={(token) => submitQrToken(token, { clearPasteField: false })} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitQrToken(qrText, { clearPasteField: true });
          }}
          className="mt-6 space-y-3"
        >
          <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">Or paste token</label>
          <textarea
            value={qrText}
            onChange={(e) => setQrText(e.target.value)}
            placeholder="Paste token here…"
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="w-full resize-y rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-900 outline-none ring-zinc-400 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={qrBusy || !qrText.trim()}
            className="w-full rounded-xl bg-zinc-900 py-3 text-sm font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {qrBusy ? "Submitting…" : "Submit token"}
          </button>
        </form>
      </section>
    </div>
  );
}
