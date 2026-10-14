import { getStudioLocalDateKey, getStudioLocalHHmm } from '../../common/date/studio-local-date';
import type { WalletAccessSnapshot, WalletMembershipEntry, WalletMembershipScope } from './wallet-access-snapshot';

/**
 * Spanish (es-MX) presentation of a WalletAccessSnapshot for a Wallet pass. Pure and
 * deterministic: dates come from the studio-local date-key / HH:mm helpers plus a fixed month
 * table, never from Intl month names (ICU versions differ between Node builds).
 *
 * Wording rules:
 * - The header says whether the MEMBERSHIP is current ("VIGENTE"), never "ACCESO": a pass is
 *   informational and access is decided at the desk.
 * - Scope text comes only from plan fields. A class-limited plan is never described as
 *   unrestricted gym access, and a day pass never claims gym-floor access (it covers allowlisted
 *   classes only).
 * - Credits REMAINING are deliberately not shown (they change with every booking); the plan's
 *   credits per period are.
 */
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] as const;

export type WalletPassDisplayField = { key: string; label: string; value: string };

export type WalletPassDisplay = {
  status: WalletPassDisplayField;
  plan: WalletPassDisplayField | null;
  validity: WalletPassDisplayField | null;
  scope: WalletPassDisplayField | null;
  /** Ordered back-of-pass lines describing each listed membership / day pass. */
  details: WalletPassDisplayField[];
  /** True only for a revoked credential's pass. Never true because a membership lapsed. */
  voided: boolean;
};

export function formatDateKeyEs(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return `${d} ${MONTHS_ES[(m ?? 1) - 1]} ${y}`;
}

export function formatInstantDateEs(instant: Date, timezone: string): string {
  return formatDateKeyEs(getStudioLocalDateKey(instant, timezone));
}

/**
 * The last moment a window is valid, shown inclusively. An end at studio-local midnight means
 * "through the previous day" (date only); any other end instant shows its date and time, so
 * "Vigente hasta el 9 oct 2026, 06:03" never overstates a window that closed in the morning.
 */
export function formatInclusiveEndEs(end: Date, timezone: string): string {
  const hhmm = getStudioLocalHHmm(end, timezone);
  if (hhmm === '00:00') {
    return formatInstantDateEs(new Date(end.getTime() - 1), timezone);
  }
  return `${formatInstantDateEs(end, timezone)}, ${hhmm}`;
}

export function describeScopeEs(scope: WalletMembershipScope): string {
  const classes = scope.allClasses ? 'Todas las clases' : 'Clases de tu plan';
  const credits = scope.classCredits !== null ? `${scope.classCredits} clases por periodo` : null;
  const gym = scope.openGym
    ? scope.openGym.windowStart && scope.openGym.windowEnd
      ? `Gimnasio ${scope.openGym.windowStart}–${scope.openGym.windowEnd}`
      : 'Gimnasio'
    : null;
  return [classes, credits, gym].filter((p): p is string => p !== null).join(' · ');
}

function membershipStatusEs(m: WalletMembershipEntry): string {
  if (m.isEntitled) return 'Vigente';
  if (m.lifecycleStatus === 'PAST_DUE') return 'Pago pendiente';
  if (m.accessState === 'NOT_STARTED') return 'Programada';
  if (m.lifecycleStatus === 'PAUSED') return 'En pausa';
  if (m.lifecycleStatus === 'CANCELED') return 'Cancelada';
  return 'Vencida';
}

function membershipValidityEs(m: WalletMembershipEntry, timezone: string): string | null {
  const start = m.effectiveStart ? new Date(m.effectiveStart) : null;
  const end = m.effectiveEnd ? new Date(m.effectiveEnd) : null;
  if (m.isEntitled) {
    if (!end) return null;
    return m.renewal === 'AUTO_RENEWS'
      ? `Renueva el ${formatInstantDateEs(end, timezone)}`
      : `Vigente hasta el ${formatInclusiveEndEs(end, timezone)}`;
  }
  if (m.lifecycleStatus === 'PAST_DUE') return 'Actualiza tu método de pago';
  if (m.accessState === 'NOT_STARTED') return start ? `Inicia el ${formatInstantDateEs(start, timezone)}` : null;
  if (m.accessState === 'EXPIRED' && end) return `Venció el ${formatInstantDateEs(end, timezone)}`;
  return null;
}

const STATUS_LABEL = 'ESTADO';

export function buildWalletPassDisplay(snapshot: WalletAccessSnapshot): WalletPassDisplay {
  const tz = snapshot.timezone;

  if (snapshot.overall === 'CREDENTIAL_REVOKED') {
    return {
      status: { key: 'status', label: STATUS_LABEL, value: 'REEMPLAZADO' },
      plan: null,
      validity: { key: 'validity', label: 'PASE', value: 'Usa el pase actual de la app' },
      scope: null,
      details: [{ key: 'replaced', label: 'PASE REEMPLAZADO', value: 'Este pase fue reemplazado por uno nuevo. Ábrelo desde la app.' }],
      voided: true,
    };
  }

  const details: WalletPassDisplayField[] = snapshot.memberships.map((m, i) => {
    const parts = [membershipStatusEs(m), membershipValidityEs(m, tz), m.isEntitled ? describeScopeEs(m.scope) : null];
    return { key: `membership_${i + 1}`, label: m.planName.toUpperCase(), value: parts.filter(Boolean).join(' · ') };
  });
  for (const [i, d] of snapshot.dayPasses.entries()) {
    details.push({
      key: `day_pass_${i + 1}`,
      label: 'PASE DE DÍA',
      value: `${d.relative === 'today' ? 'Hoy' : 'Programado'} · ${formatDateKeyEs(d.dateKey)} · Clases del pase de día`,
    });
  }

  const headline = snapshot.headline;
  const entitledCount = snapshot.memberships.filter((m) => m.isEntitled).length;

  switch (snapshot.overall) {
    case 'ACCESS_VALID': {
      const primary = headline!;
      return {
        status: { key: 'status', label: STATUS_LABEL, value: 'VIGENTE' },
        plan:
          entitledCount > 1
            ? { key: 'plan', label: 'MEMBRESÍAS', value: `${primary.planName} + ${entitledCount - 1} más` }
            : { key: 'plan', label: 'PLAN', value: primary.planName },
        validity: membershipValidityLine(primary, tz),
        scope: { key: 'scope', label: 'INCLUYE', value: describeScopeEs(primary.scope) },
        details,
        voided: false,
      };
    }
    case 'DAY_PASS_TODAY': {
      const today = snapshot.dayPasses.find((d) => d.relative === 'today')!;
      return {
        status: { key: 'status', label: STATUS_LABEL, value: 'PASE DE DÍA' },
        plan: { key: 'plan', label: 'PASE', value: 'Pase de día' },
        validity: { key: 'validity', label: 'VIGENCIA', value: `Válido hoy, ${formatDateKeyEs(today.dateKey)}` },
        scope: { key: 'scope', label: 'INCLUYE', value: 'Clases del pase de día' },
        details,
        voided: false,
      };
    }
    case 'PAYMENT_PENDING':
      return {
        status: { key: 'status', label: STATUS_LABEL, value: 'PAGO PENDIENTE' },
        plan: { key: 'plan', label: 'PLAN', value: headline!.planName },
        validity: membershipValidityLine(headline!, tz),
        scope: null,
        details,
        voided: false,
      };
    case 'SCHEDULED':
      return {
        status: { key: 'status', label: STATUS_LABEL, value: 'PROGRAMADA' },
        plan: { key: 'plan', label: 'PLAN', value: headline!.planName },
        validity: membershipValidityLine(headline!, tz),
        scope: null,
        details,
        voided: false,
      };
    case 'INACTIVE':
      return {
        status: { key: 'status', label: STATUS_LABEL, value: headline!.accessState === 'EXPIRED' ? 'VENCIDA' : 'NO VIGENTE' },
        plan: { key: 'plan', label: 'PLAN', value: headline!.planName },
        validity: membershipValidityLine(headline!, tz),
        scope: null,
        details,
        voided: false,
      };
    case 'NO_MEMBERSHIP':
    default:
      return {
        status: { key: 'status', label: STATUS_LABEL, value: 'SIN MEMBRESÍA' },
        plan: null,
        validity: null,
        scope: null,
        details,
        voided: false,
      };
  }
}

function membershipValidityLine(m: WalletMembershipEntry, timezone: string): WalletPassDisplayField | null {
  const value = membershipValidityEs(m, timezone);
  return value ? { key: 'validity', label: 'VIGENCIA', value } : null;
}
