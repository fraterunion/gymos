"use client";

import { useCallback, useState } from "react";

export function CopyFieldRow({ label, value }: { label: string; value: string | null }) {
  const [copied, setCopied] = useState(false);
  const display = value?.trim() ? value : "—";

  const onCopy = useCallback(async () => {
    if (!value?.trim()) return;
    try {
      await navigator.clipboard.writeText(value.trim());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }, [value]);

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <p className="mt-0.5 truncate font-mono text-sm text-zinc-200">{display}</p>
      </div>
      <button
        type="button"
        onClick={() => void onCopy()}
        disabled={!value?.trim()}
        className="shrink-0 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
