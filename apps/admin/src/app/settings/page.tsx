"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useDeskStudio } from "@/contexts/DeskStudioContext";
import { ApiError } from "@/lib/api/errors";
import {
  fetchStudioSettings,
  updateBookingRules,
  updateBrandingSettings,
  updateGeneralSettings,
  type StudioSettingsDto,
} from "@/lib/api/settings";

const INPUT =
  "w-full rounded-xl border border-zinc-700/90 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500/70 focus:outline-none focus:ring-1 focus:ring-violet-500/40";

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
];

const CANCEL_HOURS_BASE = [1, 2, 3, 6, 12, 24, 48, 72, 168] as const;
const CHECKIN_MINUTES_BASE = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120] as const;

function mergeIntOptions(base: readonly number[], current: number): number[] {
  return Array.from(new Set([...base, current])).sort((a, b) => a - b);
}

function hexForColorInput(hex: string, fallback: string): string {
  const t = hex.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) {
    const r = t[1]!;
    const g = t[2]!;
    const b = t[3]!;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

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
        {subtitle ? <p className="mt-1 text-sm text-zinc-500">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 border-b border-zinc-800/50 py-4 last:border-b-0">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-100">{label}</span>
        {description ? <span className="mt-1 block text-xs leading-relaxed text-zinc-500">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 rounded border-zinc-600 bg-zinc-950 text-violet-600 focus:ring-violet-500/40"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

function formsFromDto(res: StudioSettingsDto) {
  return {
    general: {
      name: res.general.name,
      timezone: res.general.timezone,
      supportEmail: res.general.supportEmail ?? "",
      supportPhone: res.general.supportPhone ?? "",
      websiteUrl: res.general.websiteUrl ?? "",
      instagramHandle: res.general.instagramHandle ?? "",
      address: res.general.address ?? "",
    },
    branding: {
      logoUrl: res.branding.logoUrl ?? "",
      coverImageUrl: res.branding.coverImageUrl ?? "",
      primaryColor:
        res.branding.primaryColor ??
        res.branding.legacyBrandPrimaryColor ??
        res.branding.effectivePrimaryColor,
      accentColor:
        res.branding.accentColor ??
        res.branding.legacyBrandSecondaryColor ??
        res.branding.effectiveAccentColor,
    },
    booking: { ...res.bookingRules },
  };
}

type SaveKey = "general" | "branding" | "booking";

export default function StudioSettingsPage() {
  const { selectedStudioId, selected, loading: studiosLoading, error: studiosError } = useDeskStudio();

  const canManage = selected?.role === "OWNER" || selected?.role === "ADMIN";

  const [data, setData] = useState<StudioSettingsDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<SaveKey | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [general, setGeneral] = useState({
    name: "",
    timezone: "UTC",
    supportEmail: "",
    supportPhone: "",
    websiteUrl: "",
    instagramHandle: "",
    address: "",
  });

  const [branding, setBranding] = useState({
    logoUrl: "",
    coverImageUrl: "",
    primaryColor: "#7c3aed",
    accentColor: "#22c55e",
  });

  const [booking, setBooking] = useState({
    allowWaitlist: true,
    autoConfirmWaitlist: false,
    cancellationWindowHours: 12,
    lateCancelPenaltyEnabled: false,
    checkInWindowMinutes: 15,
  });

  const applyServerData = useCallback((res: StudioSettingsDto) => {
    setData(res);
    const f = formsFromDto(res);
    setGeneral(f.general);
    setBranding(f.branding);
    setBooking(f.booking);
  }, []);

  const reload = useCallback(async () => {
    if (!selectedStudioId || !canManage) {
      setData(null);
      setLoading(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchStudioSettings(selectedStudioId);
      applyServerData(res);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 403
            ? "You need owner or admin access to manage studio settings."
            : e.message
          : "Could not load settings.";
      setLoadError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [selectedStudioId, canManage, applyServerData]);

  useEffect(() => {
    queueMicrotask(() => {
      void reload();
    });
  }, [reload]);

  const cancelHourOptions = useMemo(
    () => mergeIntOptions(CANCEL_HOURS_BASE, booking.cancellationWindowHours),
    [booking.cancellationWindowHours],
  );
  const checkInMinuteOptions = useMemo(
    () => mergeIntOptions(CHECKIN_MINUTES_BASE, booking.checkInWindowMinutes),
    [booking.checkInWindowMinutes],
  );

  const preview = useMemo(() => {
    const primary = branding.primaryColor || "#7c3aed";
    const accent = branding.accentColor || "#22c55e";
    const name = general.name || data?.general.name || "Studio";
    const logo = branding.logoUrl.trim() || data?.branding.effectiveLogoUrl || null;
    const cover = branding.coverImageUrl.trim();
    return { primary, accent, name, logo, cover };
  }, [branding, general.name, data]);

  async function runSave(key: SaveKey, fn: () => Promise<StudioSettingsDto>) {
    if (!selectedStudioId) return;
    setSectionError(null);
    setSaving(key);
    try {
      const next = await fn();
      applyServerData(next);
      setFlash("Saved");
      window.setTimeout(() => setFlash(null), 2200);
    } catch (e) {
      setSectionError(e instanceof ApiError ? e.message : "Save failed.");
    } finally {
      setSaving(null);
    }
  }

  const onSaveGeneral = () => {
    if (!selectedStudioId) return;
    void runSave("general", () =>
      updateGeneralSettings(selectedStudioId, {
        name: general.name.trim(),
        timezone: general.timezone.trim(),
        supportEmail: general.supportEmail.trim() || null,
        supportPhone: general.supportPhone.trim() || null,
        websiteUrl: general.websiteUrl.trim() || null,
        instagramHandle: general.instagramHandle.trim().replace(/^@+/, "") || null,
        address: general.address.trim() || null,
      }),
    );
  };

  const onSaveBranding = () => {
    if (!selectedStudioId) return;
    void runSave("branding", () =>
      updateBrandingSettings(selectedStudioId, {
        logoUrl: branding.logoUrl.trim() || null,
        coverImageUrl: branding.coverImageUrl.trim() || null,
        primaryColor: branding.primaryColor.trim() || null,
        accentColor: branding.accentColor.trim() || null,
      }),
    );
  };

  const onSaveBooking = () => {
    if (!selectedStudioId) return;
    void runSave("booking", () =>
      updateBookingRules(selectedStudioId, {
        allowWaitlist: booking.allowWaitlist,
        autoConfirmWaitlist: booking.autoConfirmWaitlist,
        cancellationWindowHours: booking.cancellationWindowHours,
        lateCancelPenaltyEnabled: booking.lateCancelPenaltyEnabled,
        checkInWindowMinutes: booking.checkInWindowMinutes,
      }),
    );
  };

  if (studiosLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-zinc-500">Loading studios…</p>
      </div>
    );
  }

  if (studiosError) {
    return (
      <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-4 text-sm text-red-200">
        {studiosError}
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        <h1 className="text-lg font-semibold text-zinc-100">Studio settings</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Only owners and admins can open branding and operational settings. Ask a studio admin for access.
        </p>
      </div>
    );
  }

  if (!selectedStudioId) {
    return (
      <p className="text-sm text-zinc-500">Select a studio from the header to manage settings.</p>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-zinc-800" />
        <div className="h-64 animate-pulse rounded-2xl bg-zinc-900/50" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="rounded-xl border border-red-900/40 bg-red-950/15 p-4 text-sm text-red-200">
        {loadError ?? "Settings unavailable."}
      </div>
    );
  }

  return (
    <div className="space-y-10 pb-16">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Studio settings</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-500">
            Branding and booking rules for your studio. FraterUnion manages native app identifiers in the internal
            platform console.
          </p>
        </div>
        {flash ? (
          <span className="text-xs font-medium text-emerald-400" role="status">
            {flash}
          </span>
        ) : data ? (
          <span className="text-xs text-zinc-600">
            Last updated {new Date(data.updatedAt).toLocaleString()}
          </span>
        ) : null}
      </header>

      {sectionError ? (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-100">
          {sectionError}
        </div>
      ) : null}

      <SectionCard
        title="Studio information"
        subtitle="How members reach you and how the studio is labeled in the desk."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Studio name</span>
            <input
              className={INPUT}
              value={general.name}
              onChange={(e) => setGeneral((s) => ({ ...s, name: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Timezone</span>
            <input
              className={INPUT}
              list="tz-list"
              value={general.timezone}
              onChange={(e) => setGeneral((s) => ({ ...s, timezone: e.target.value }))}
            />
            <datalist id="tz-list">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Support email</span>
            <input
              className={INPUT}
              type="email"
              autoComplete="email"
              value={general.supportEmail}
              onChange={(e) => setGeneral((s) => ({ ...s, supportEmail: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Phone</span>
            <input
              className={INPUT}
              type="tel"
              value={general.supportPhone}
              onChange={(e) => setGeneral((s) => ({ ...s, supportPhone: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Website</span>
            <input
              className={INPUT}
              placeholder="https://"
              value={general.websiteUrl}
              onChange={(e) => setGeneral((s) => ({ ...s, websiteUrl: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Instagram</span>
            <div className="flex rounded-xl border border-zinc-700/90 bg-zinc-950 focus-within:border-violet-500/70 focus-within:ring-1 focus-within:ring-violet-500/40">
              <span className="flex items-center pl-3 text-sm text-zinc-500">@</span>
              <input
                className="min-w-0 flex-1 border-0 bg-transparent py-2.5 pr-3 text-sm text-zinc-100 outline-none"
                value={general.instagramHandle}
                onChange={(e) => setGeneral((s) => ({ ...s, instagramHandle: e.target.value }))}
              />
            </div>
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Address</span>
            <textarea
              className={`${INPUT} min-h-[88px] resize-y`}
              value={general.address}
              onChange={(e) => setGeneral((s) => ({ ...s, address: e.target.value }))}
            />
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "general"}
            onClick={onSaveGeneral}
            className="rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:bg-violet-600 dark:text-white dark:hover:bg-violet-500"
          >
            {saving === "general" ? "Saving…" : "Save changes"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Branding" subtitle="Logo, cover art, and accent colors used across desk surfaces.">
        <div className="grid gap-8 lg:grid-cols-2">
          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Logo URL</span>
              <input
                className={INPUT}
                value={branding.logoUrl}
                onChange={(e) => setBranding((s) => ({ ...s, logoUrl: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-zinc-400">Cover image URL</span>
              <input
                className={INPUT}
                value={branding.coverImageUrl}
                onChange={(e) => setBranding((s) => ({ ...s, coverImageUrl: e.target.value }))}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Primary</span>
                <div className="flex gap-2">
                  <input
                    type="color"
                    className="h-11 w-14 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 p-1"
                    value={hexForColorInput(branding.primaryColor, "#7c3aed")}
                    onChange={(e) => setBranding((s) => ({ ...s, primaryColor: e.target.value }))}
                  />
                  <input
                    className={INPUT}
                    value={branding.primaryColor}
                    onChange={(e) => setBranding((s) => ({ ...s, primaryColor: e.target.value }))}
                  />
                </div>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-zinc-400">Accent</span>
                <div className="flex gap-2">
                  <input
                    type="color"
                    className="h-11 w-14 cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 p-1"
                    value={hexForColorInput(branding.accentColor, "#22c55e")}
                    onChange={(e) => setBranding((s) => ({ ...s, accentColor: e.target.value }))}
                  />
                  <input
                    className={INPUT}
                    value={branding.accentColor}
                    onChange={(e) => setBranding((s) => ({ ...s, accentColor: e.target.value }))}
                  />
                </div>
              </label>
            </div>
          </div>

          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Live preview</p>
            <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
              <div
                className="relative h-28 bg-cover bg-center"
                style={
                  preview.cover
                    ? { backgroundImage: `url(${preview.cover})` }
                    : { background: `linear-gradient(135deg, ${preview.primary}, #18181b)` }
                }
              >
                <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/90 to-transparent" />
              </div>
              <div className="space-y-4 p-5">
                <div className="flex items-center gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
                    {preview.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- external branding URLs
                      <img src={preview.logo} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-lg font-bold text-zinc-500">{preview.name.slice(0, 1)}</span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-zinc-50">{preview.name}</p>
                    <p className="text-xs text-zinc-500">Sample desk surface</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    style={{ backgroundColor: preview.primary }}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm"
                  >
                    Book class
                  </button>
                  <button
                    type="button"
                    style={{ backgroundColor: preview.accent, color: "#052e16" }}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm"
                  >
                    Join waitlist
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "branding"}
            onClick={onSaveBranding}
            className="rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:bg-violet-600 dark:text-white dark:hover:bg-violet-500"
          >
            {saving === "branding" ? "Saving…" : "Save branding"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Booking rules" subtitle="Waitlists, cutoffs, and check-in windows.">
        <div className="space-y-1">
          <ToggleRow
            label="Allow waitlist"
            description="Members can join a waitlist when a class is full."
            checked={booking.allowWaitlist}
            onChange={(v) => setBooking((b) => ({ ...b, allowWaitlist: v }))}
          />
          <ToggleRow
            label="Auto-confirm waitlist"
            description="When enabled, promoted waitlist spots confirm without manual review."
            checked={booking.autoConfirmWaitlist}
            disabled={!booking.allowWaitlist}
            onChange={(v) => setBooking((b) => ({ ...b, autoConfirmWaitlist: v }))}
          />
          <ToggleRow
            label="Late cancel penalties"
            description="Track or enforce penalties when members cancel inside the window."
            checked={booking.lateCancelPenaltyEnabled}
            onChange={(v) => setBooking((b) => ({ ...b, lateCancelPenaltyEnabled: v }))}
          />
        </div>
        <div className="mt-6 grid gap-6 border-t border-zinc-800/60 pt-6 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Cancellation window (hours)</span>
            <select
              className={INPUT}
              value={booking.cancellationWindowHours}
              onChange={(e) =>
                setBooking((b) => ({ ...b, cancellationWindowHours: Number(e.target.value) }))
              }
            >
              {cancelHourOptions.map((h) => (
                <option key={h} value={h}>
                  {h}h
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-zinc-400">Check-in window (minutes before)</span>
            <select
              className={INPUT}
              value={booking.checkInWindowMinutes}
              onChange={(e) =>
                setBooking((b) => ({ ...b, checkInWindowMinutes: Number(e.target.value) }))
              }
            >
              {checkInMinuteOptions.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "Start of class" : `${m} min`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={saving === "booking"}
            onClick={onSaveBooking}
            className="rounded-xl bg-zinc-100 px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-wait disabled:opacity-60 dark:bg-violet-600 dark:text-white dark:hover:bg-violet-500"
          >
            {saving === "booking" ? "Saving…" : "Save booking rules"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Danger zone" subtitle="Destructive actions for this studio.">
        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            disabled
            className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-500"
          >
            Archive studio
          </button>
          <button
            type="button"
            disabled
            className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-500"
          >
            Transfer ownership
          </button>
        </div>
        <p className="mt-3 text-xs text-zinc-600">Coming soon</p>
      </SectionCard>
    </div>
  );
}
