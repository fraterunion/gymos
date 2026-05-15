/**
 * FraterUnion Platform Console — who may open `/platform` in admin.
 * Keep in sync with API `PlatformOperatorService` (domain + extra list).
 */
function normalizeDomain(raw: string | undefined): string {
  const d = (raw ?? "fraterunion.co").trim().toLowerCase().replace(/^@/, "");
  return d || "fraterunion.co";
}

function extraAllowlist(): string[] {
  const raw = process.env.NEXT_PUBLIC_PLATFORM_EXTRA_OPERATOR_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isPlatformOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  const domain = normalizeDomain(process.env.NEXT_PUBLIC_PLATFORM_OPERATOR_EMAIL_DOMAIN);
  if (e.endsWith(`@${domain}`)) return true;
  return extraAllowlist().includes(e);
}
