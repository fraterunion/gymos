"use client";

import { useEffect, useState } from "react";

import { fetchCampaignEmailPreview } from "@/lib/api/communications";
import { ApiError } from "@/lib/api/errors";
import { EMAIL_PREVIEW_VIEWPORTS, emailPreviewRequest, type EmailPreviewViewport } from "@/lib/campaignEmailPreview";

const DEBOUNCE_MS = 400;

type Rendered = { studioId: string; subject: string; bodyText: string; html: string };

/**
 * The campaign email exactly as the API renders it for delivery. The HTML is shown in a fully
 * sandboxed iframe: no scripts, an opaque origin, and links that cannot open anything.
 */
export function CampaignEmailPreview({
  studioId,
  subject,
  bodyText,
}: {
  studioId: string | null;
  subject: string;
  bodyText: string;
}) {
  const [viewport, setViewport] = useState<EmailPreviewViewport>("desktop");
  const [rendered, setRendered] = useState<Rendered | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = emailPreviewRequest(subject, bodyText);
  const subjectToRender = request?.subject ?? null;
  const bodyToRender = request?.bodyText ?? null;

  useEffect(() => {
    if (!studioId || subjectToRender === null || bodyToRender === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchCampaignEmailPreview(studioId, { subject: subjectToRender, bodyText: bodyToRender })
        .then((result) => {
          if (cancelled) return;
          setRendered({ studioId, subject: subjectToRender, bodyText: bodyToRender, html: result.html });
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof ApiError ? e.message : "No se pudo generar la vista del correo.");
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [studioId, subjectToRender, bodyToRender]);

  const shown = rendered && rendered.studioId === studioId ? rendered : null;
  const upToDate = shown !== null && shown.subject === subjectToRender && shown.bodyText === bodyToRender;
  const width = EMAIL_PREVIEW_VIEWPORTS.find((option) => option.id === viewport)?.width ?? null;

  return (
    <section className="space-y-2" aria-label="Vista previa del correo">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-zinc-800">Así se verá el correo</p>
          <p className="text-xs text-zinc-500">
            {request === null
              ? "Escribe un asunto y un mensaje para verlo con el diseño del estudio."
              : upToDate
                ? "Diseño final: el asunto es el título y el mensaje va debajo."
                : "Actualizando vista previa…"}
          </p>
        </div>
        <div role="group" aria-label="Tamaño de la vista previa" className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-0.5">
          {EMAIL_PREVIEW_VIEWPORTS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={viewport === option.id}
              onClick={() => setViewport(option.id)}
              className={`rounded-lg px-3 py-1 text-xs font-medium transition ${
                viewport === option.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-[#F0F0F0]">
        {request !== null && shown ? (
          <iframe
            title="Vista previa del correo"
            sandbox=""
            srcDoc={shown.html}
            className={`mx-auto block h-[640px] border-0 transition-opacity ${upToDate ? "" : "opacity-60"} ${
              width ? "ring-1 ring-zinc-200" : ""
            }`}
            style={{ width: width ? `${width}px` : "100%" }}
          />
        ) : (
          <p className="px-4 py-12 text-center text-sm text-zinc-500">
            {request === null ? "La vista previa aparece aquí." : "Generando vista previa…"}
          </p>
        )}
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <p className="text-xs text-zinc-500">
        Los enlaces están desactivados en la vista previa. El enlace para cancelar la suscripción se genera para cada destinatario al enviar.
      </p>
    </section>
  );
}
