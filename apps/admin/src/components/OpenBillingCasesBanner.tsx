"use client";

import Link from "next/link";

import type { MemberBillingCaseView } from "@/lib/api/members";

const SEVERITY_LABEL: Record<MemberBillingCaseView["severity"], string> = { CRITICAL: "Crítico", HIGH: "Alto", MEDIUM: "Medio", LOW: "Bajo" };

/**
 * Member 360: unresolved reconciliation cases for this member. Rendered above the KPIs so a
 * paid-but-no-access or Stripe/GymOS disagreement is the first thing staff see.
 */
export function OpenBillingCasesBanner({ cases, onReview }: { cases: readonly MemberBillingCaseView[]; onReview: () => void }) {
  const visible = cases.filter((c) => c.severity === "CRITICAL" || c.severity === "HIGH" || c.severity === "MEDIUM");
  if (visible.length === 0) return null;
  const critical = visible.some((c) => c.severity === "CRITICAL");
  return (
    <section className={`rounded-xl border p-5 ${critical ? "border-red-200 bg-red-50/70" : "border-amber-200 bg-amber-50/60"}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={`text-xs font-semibold uppercase tracking-wider ${critical ? "text-red-900" : "text-amber-900"}`}>
          {critical ? "Caso de facturación crítico" : "Caso de facturación pendiente"}
        </h2>
        <Link href="/billing/exceptions" className="text-xs font-semibold text-zinc-900 underline">Ver todos los casos</Link>
      </div>
      <div className="mt-3 space-y-2">
        {visible.map((c) => (
          <div key={c.id} className="rounded-lg border border-white/60 bg-white px-3 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${c.severity === "CRITICAL" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>{SEVERITY_LABEL[c.severity]}</span>
              <p className="text-sm font-medium text-zinc-900">{c.title}</p>
              {c.status === "ACKNOWLEDGED" ? <span className="text-xs text-zinc-500">· Este caso ya fue revisado</span> : null}
            </div>
            <p className="mt-1 text-xs text-zinc-600">{c.summary}</p>
            <p className="mt-1 text-xs text-zinc-900"><span className="font-semibold">Acción recomendada:</span> {c.suggestedAction}</p>
            <button type="button" onClick={onReview} className="mt-2 text-xs font-semibold text-zinc-900 underline">Revisar facturación</button>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-zinc-600">Mientras el caso siga abierto, no registres cobros manuales para este miembro: podría cobrarse dos veces.</p>
    </section>
  );
}
