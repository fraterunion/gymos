"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/errors";
import {
  applyMembershipPriceChange,
  previewMembershipPriceChange,
  retryMembershipPriceChange,
  type PriceChangeMember,
  type PriceChangePreview,
  type PriceChangeScope,
} from "@/lib/api/memberships";
import { adminInput, adminPrimaryBtn, adminSecondaryBtn } from "@/lib/adminSurface";
import { formatCents } from "@/app/memberships/memberships-ui";

export function PriceChangeDialog({
  studioId,
  planId,
  planName,
  currency,
  oldPriceCents,
  newPriceCents,
  idempotencyKey,
  onCancel,
  onApplied,
  beforeApply,
}: {
  studioId: string;
  planId: string;
  planName: string;
  currency: string;
  oldPriceCents: number;
  newPriceCents: number;
  idempotencyKey: string;
  onCancel: () => void;
  onApplied: () => void;
  beforeApply?: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<PriceChangePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<PriceChangeScope>("FUTURE_ONLY");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failedChangeId, setFailedChangeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void previewMembershipPriceChange(studioId, planId, newPriceCents)
      .then((row) => { if (!cancelled) setPreview(row); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "No se pudo calcular el cambio.");
      });
    return () => { cancelled = true; };
  }, [studioId, planId, newPriceCents]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const members = preview?.members ?? [];
    if (!needle) return members;
    return members.filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(needle),
    );
  }, [preview, query]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const changing = scope === "ALL_EXISTING"
    ? preview?.counts.wouldChange ?? 0
    : scope === "SELECTED"
      ? (preview?.members ?? []).filter((member) => selected.has(member.subscriptionId) && member.currentPriceCents !== newPriceCents).length
      : 0;
  const preserved = (preview?.counts.total ?? 0) - changing;

  async function confirm() {
    if (!preview) return;
    if (scope === "SELECTED" && selected.size === 0) {
      setError("Selecciona al menos un miembro.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (beforeApply) await beforeApply();
      const result = await applyMembershipPriceChange(studioId, planId, {
        newPriceCents,
        scope,
        subscriptionIds: scope === "SELECTED" ? [...selected] : undefined,
        idempotencyKey,
        confirm: true,
      });
      if (result.counts.failed > 0) {
        setFailedChangeId(result.id);
        setError(`El catálogo quedó en el precio nuevo. ${result.counts.failed} suscripciones de Stripe no se actualizaron. Reintenta solo esas; las que ya se aplicaron no se vuelven a cobrar.`);
        return;
      }
      onApplied();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo aplicar el precio.");
    } finally {
      setBusy(false);
    }
  }

  async function retryFailed() {
    if (!failedChangeId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await retryMembershipPriceChange(studioId, planId, failedChangeId);
      if (result.counts.failed > 0) {
        setError(`${result.counts.failed} suscripciones de Stripe siguen sin actualizarse.`);
        return;
      }
      onApplied();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No se pudo reintentar el cambio.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[min(90vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-zinc-900">Cambio de precio · {planName}</h2>
          <p className="mt-1 text-sm text-zinc-600">
            {formatCents(oldPriceCents, currency)} → {formatCents(newPriceCents, currency)}. Los miembros nuevos usarán el precio nuevo.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          {(["FUTURE_ONLY", "ALL_EXISTING", "SELECTED"] as PriceChangeScope[]).map((option) => (
            <label key={option} className="flex items-start gap-3 text-sm text-zinc-800">
              <input type="radio" name="price-scope" checked={scope === option} onChange={() => setScope(option)} className="mt-1" />
              <span>
                {option === "FUTURE_ONLY" && "Solo miembros futuros. Los actuales conservan su precio."}
                {option === "ALL_EXISTING" && "Todos los miembros actuales y los futuros."}
                {option === "SELECTED" && "Elegir qué miembros actuales reciben el precio nuevo."}
              </span>
            </label>
          ))}
          <p className="text-sm text-zinc-600">
            {preview
              ? `${changing} suscripciones pasarían al precio nuevo. ${preserved} conservarían su precio. El ciclo de cobro no se mueve y no se genera un cobro inmediato.`
              : "Calculando miembros afectados…"}
          </p>
          {scope === "SELECTED" ? (
            <div className="space-y-2">
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar nombre o correo" className={adminInput} />
              <div className="flex gap-2">
                <button type="button" className={adminSecondaryBtn} onClick={() => setSelected(new Set(visible.map((m) => m.subscriptionId)))}>Seleccionar visibles</button>
                <button type="button" className={adminSecondaryBtn} onClick={() => setSelected(new Set())}>Limpiar</button>
              </div>
              <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200">
                {visible.map((member) => (
                  <MemberRow key={member.subscriptionId} member={member} currency={currency} checked={selected.has(member.subscriptionId)} onToggle={() => toggle(member.subscriptionId)} />
                ))}
                {visible.length === 0 ? <li className="px-3 py-4 text-sm text-zinc-500">Sin miembros para esta búsqueda.</li> : null}
              </ul>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4">
          <button type="button" className={adminSecondaryBtn} onClick={onCancel} disabled={busy}>Volver</button>
          {failedChangeId ? (
            <button type="button" className={adminPrimaryBtn} onClick={() => void retryFailed()} disabled={busy}>
              {busy ? "Reintentando…" : "Reintentar suscripciones fallidas"}
            </button>
          ) : (
            <button type="button" className={adminPrimaryBtn} onClick={() => void confirm()} disabled={busy || !preview}>
              {busy ? "Aplicando…" : "Confirmar cambio de precio"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  currency,
  checked,
  onToggle,
}: {
  member: PriceChangeMember;
  currency: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-zinc-900">{member.name}</span>
          <span className="block truncate text-xs text-zinc-500">{member.email} · {member.source}</span>
        </span>
        <span className="shrink-0 text-xs text-zinc-600">
          {formatCents(member.currentPriceCents, currency)} → {formatCents(member.nextPriceCents, currency)}
          {member.priceUnverified ? " · sin verificar" : ""}
        </span>
      </label>
    </li>
  );
}
