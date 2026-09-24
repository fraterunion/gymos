import { apiRequest } from '@/lib/api/client';

export type DayPassStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REFUNDED';
export type DayPassRelativeDay = 'today' | 'upcoming' | 'past';

export type DayPassDto = {
  id: string;
  /** UTC ISO string of studio-local midnight on the pass's day (legacy field). */
  validForDate: string;
  /**
   * The pass's day as a canonical studio-local 'YYYY-MM-DD' key. Display THIS; never re-derive
   * the day from the device clock. Absent only on API builds older than the date-selection release.
   */
  validForDateKey?: string;
  /** Server-side classification against studio-local today (absent on older API builds). */
  relativeDay?: DayPassRelativeDay;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  createdAt: string;
};

export type DayPassPaymentSheetDto = {
  dayPassId: string;
  /** The studio-local day the server resolved this checkout to ('YYYY-MM-DD'); absent on older API builds. */
  validForDate?: string;
  paymentIntentClientSecret: string;
  customerId: string;
  ephemeralKeySecret: string;
  publishableKey: string;
};

export type DayPassCatalogDto = {
  displayName: string;
  priceCents: number;
  currency: string;
  active: boolean;
  validityDescription: string;
};

/** Everything the date picker needs, computed on the studio clock by the server. */
export type DayPassPurchaseWindowDto = {
  timezone: string;
  todayKey: string;
  maxDateKey: string;
  horizonDays: number;
  ownedDateKeys: string[];
};

export type DayPassListScope = 'all' | 'upcoming' | 'history';

export async function fetchDayPassCatalog(studioId: string): Promise<DayPassCatalogDto> {
  return apiRequest<DayPassCatalogDto>(`/studios/${studioId}/day-pass/catalog`, { method: 'GET' });
}

export async function fetchPublicDayPassCatalog(slug: string): Promise<DayPassCatalogDto> {
  return apiRequest<DayPassCatalogDto>(`/public/studios/${slug}/day-pass`, { method: 'GET' });
}

/**
 * Purchased (ACTIVE) passes only. `upcoming` = today and future days soonest first;
 * `history` = past days; omitted = every pass newest-first (legacy order).
 */
export async function fetchMyDayPasses(studioId: string, scope?: DayPassListScope): Promise<DayPassDto[]> {
  const q = scope ? `?scope=${scope}` : '';
  return apiRequest<DayPassDto[]>(`/studios/${studioId}/day-passes/me${q}`, { method: 'GET' });
}

export async function fetchDayPassPurchaseWindow(studioId: string): Promise<DayPassPurchaseWindowDto> {
  return apiRequest<DayPassPurchaseWindowDto>(`/studios/${studioId}/day-passes/purchase-window`, {
    method: 'GET',
  });
}

/**
 * Starts (or resumes) the purchase of a Day Pass for the member's CHOSEN studio-local day.
 * The date is a request: the server canonicalises it on the studio clock and rejects past days,
 * non-calendar keys and days beyond its purchase horizon. A retry after an abandoned or declined
 * PaymentSheet for the same day resumes the same attempt; a different day is a separate attempt.
 */
export async function createDayPassPaymentSheet(
  studioId: string,
  validForDate: string,
): Promise<DayPassPaymentSheetDto> {
  return apiRequest<DayPassPaymentSheetDto>(`/studios/${studioId}/day-passes/payment-sheet`, {
    method: 'POST',
    body: JSON.stringify({ validForDate }),
  });
}

/**
 * Server-verified refresh after PaymentSheet reports success. The API asks Stripe for the live
 * intent status and activates the pass through the same routine the webhook uses; the client's
 * own claim of success never activates anything.
 */
export async function syncDayPass(studioId: string, dayPassId: string): Promise<DayPassDto> {
  return apiRequest<DayPassDto>(`/studios/${studioId}/day-passes/${dayPassId}/sync`, {
    method: 'POST',
  });
}
