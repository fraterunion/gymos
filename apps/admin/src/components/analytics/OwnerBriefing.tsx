"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { OwnerBriefingDto } from "@/lib/api/analytics";

function fmtMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n);
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function CountUpAmount({ cents, loading }: { cents: number; loading: boolean }) {
  const reducedMotion = usePrefersReducedMotion();
  const [display, setDisplay] = useState(0);
  const ran = useRef(false);

  useEffect(() => {
    if (loading) {
      setDisplay(0);
      ran.current = false;
      return;
    }

    if (reducedMotion || ran.current) {
      setDisplay(cents);
      return;
    }

    ran.current = true;
    const duration = 700;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setDisplay(Math.round(cents * eased));
      if (t < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
  }, [cents, loading, reducedMotion]);

  if (loading) {
    return (
      <div
        className="h-[3.5rem] w-56 max-w-full animate-pulse rounded-lg bg-zinc-100 sm:h-[4.5rem] dark:bg-zinc-800"
        aria-hidden
      />
    );
  }

  return (
    <p className="font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50 text-[2.75rem] leading-none sm:text-[4.5rem]">
      {fmtMoney(display)}
    </p>
  );
}

function BriefingSkeleton() {
  return (
    <div className="space-y-10 animate-pulse">
      <div className="space-y-3">
        <div className="h-3 w-40 rounded bg-zinc-100 dark:bg-zinc-800" />
        <div className="h-14 w-64 rounded bg-zinc-100 dark:bg-zinc-800" />
        <div className="h-4 w-48 rounded bg-zinc-100 dark:bg-zinc-800" />
      </div>
      <div className="grid gap-10 md:grid-cols-2">
        <div className="space-y-3">
          <div className="h-3 w-32 rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
        <div className="space-y-3">
          <div className="h-3 w-28 rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-full rounded bg-zinc-100 dark:bg-zinc-800" />
          <div className="h-4 w-3/4 rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      </div>
    </div>
  );
}

function AttentionRow({
  label,
  action,
  href,
}: {
  label: string;
  action: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-4 rounded-lg py-2.5 text-[15px] text-zinc-800 transition hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-900/60"
    >
      <span>{label}</span>
      <span className="shrink-0 text-sm text-zinc-500 transition group-hover:text-zinc-800 dark:group-hover:text-zinc-200">
        {action} →
      </span>
    </Link>
  );
}

function ChangeRow({ label }: { label: string }) {
  return <p className="py-2 text-[15px] text-zinc-700 dark:text-zinc-300">{label}</p>;
}

type OwnerBriefingProps = {
  briefing: OwnerBriefingDto | null;
  studioName: string | null;
  lastUpdated: string | null;
  loading: boolean;
  onScrollToAnalytics: () => void;
};

export function OwnerBriefing({
  briefing,
  studioName,
  lastUpdated,
  loading,
  onScrollToAnalytics,
}: OwnerBriefingProps) {
  const reducedMotion = usePrefersReducedMotion();

  if (loading && !briefing) {
    return <BriefingSkeleton />;
  }

  const hero = briefing?.hero;
  const attention = briefing?.attention ?? [];
  const whatChanged = briefing?.whatChanged ?? [];
  const paying = briefing?.payingMembers;

  const comparison =
    hero?.monthComparisonPercent != null
      ? `${hero.monthComparisonPercent >= 0 ? "↑" : "↓"} ${Math.abs(hero.monthComparisonPercent)}% vs same point last month`
      : null;

  const panelEnter = reducedMotion ? "" : "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500";

  return (
    <div className={`mx-auto w-full max-w-[840px] space-y-12 ${panelEnter}`}>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Analytics
        </h1>
        {studioName ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{studioName}</p>
        ) : null}
        {lastUpdated ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">Updated {lastUpdated}</p>
        ) : null}
      </header>

      <section aria-label="Collected this month" className="space-y-3">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Collected this month
        </p>
        <CountUpAmount cents={hero?.monthCollectedCents ?? 0} loading={loading && !hero} />
        {hero ? (
          <p className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
            {fmtCount(hero.monthPaymentCount)} payment{hero.monthPaymentCount === 1 ? "" : "s"}{" "}
            collected
          </p>
        ) : null}
        {comparison ? (
          <p className="text-sm tabular-nums text-zinc-500 dark:text-zinc-400">{comparison}</p>
        ) : null}
        {hero?.delight ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{hero.delight}</p>
        ) : null}
      </section>

      <div className="grid gap-12 md:grid-cols-2 md:gap-10">
        <section aria-label="Needs your attention">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            Needs your attention
          </h2>
          {attention.length === 0 ? (
            <p className="text-[15px] text-zinc-600 dark:text-zinc-400">
              ✓ Everything looks healthy today.
            </p>
          ) : (
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
              {attention.map((item) => (
                <AttentionRow
                  key={item.id}
                  label={item.label}
                  action={item.action}
                  href={item.href}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-label="What changed">
          <h2 className="mb-3 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            What changed
          </h2>
          {whatChanged.length === 0 ? (
            <p className="text-[15px] text-zinc-500 dark:text-zinc-500">No activity yet today.</p>
          ) : (
            <div>
              {whatChanged.map((row) => (
                <ChangeRow key={row.id} label={row.label} />
              ))}
            </div>
          )}
        </section>
      </div>

      <section aria-label="Paying members" className="space-y-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          Paying members
        </p>
        {loading && !paying ? (
          <div className="h-9 w-20 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        ) : (
          <>
            <p className="text-[2rem] font-semibold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-[2.25rem]">
              {fmtCount(paying?.count ?? 0)}
            </p>
            {paying?.newThisWeek != null ? (
              <p className="text-sm tabular-nums text-zinc-600 dark:text-zinc-400">
                +{fmtCount(paying.newThisWeek)} this week
              </p>
            ) : null}
            {paying?.renewalsDueThisWeek != null ? (
              <p className="text-sm tabular-nums text-zinc-500 dark:text-zinc-500">
                {fmtCount(paying.renewalsDueThisWeek)} renewal
                {paying.renewalsDueThisWeek === 1 ? "" : "s"} due this week
              </p>
            ) : null}
          </>
        )}
      </section>

      <div className="border-t border-zinc-200 pt-10 dark:border-zinc-800">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Want deeper insights?</p>
        <button
          type="button"
          onClick={onScrollToAnalytics}
          className="mt-2 text-sm text-zinc-600 underline-offset-4 transition hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Open Analytics ↓
        </button>
      </div>
    </div>
  );
}
