const LOCALE = "es-MX";

/**
 * Owner-facing money format: `$4,250 MXN`
 *
 * Currency source of truth (in priority order):
 * 1. `StudioEnrollmentSettings.currency` via GET `/studios/:id/enrollment/settings`
 * 2. Per-plan or per-payment `currency` on transactional surfaces (sales, memberships)
 *
 * Do not hardcode USD/MXN in feature pages — pass the resolved studio currency.
 */
export function formatMoneyFromCents(
  cents: number,
  currency: string,
  opts?: { maximumFractionDigits?: number },
): string {
  const code = (currency || "mxn").trim().toUpperCase();
  const value = cents / 100;
  const maxFrac = opts?.maximumFractionDigits ?? (cents % 100 === 0 ? 0 : 2);

  try {
    const parts = new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFrac,
    }).formatToParts(value);

    const symbol = parts.find((p) => p.type === "currency")?.value ?? "$";
    const number = parts
      .filter((p) =>
        ["integer", "group", "decimal", "fraction", "literal"].includes(p.type),
      )
      .map((p) => p.value)
      .join("")
      .trim();

    return `${symbol}${number} ${code}`;
  } catch {
    return `${value.toFixed(maxFrac)} ${code}`;
  }
}

/** Compact chart axis label — symbol + amount without trailing code. */
export function formatMoneyAxis(cents: number, currency: string): string {
  const code = (currency || "mxn").trim().toUpperCase();
  try {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(0)}`;
  }
}
