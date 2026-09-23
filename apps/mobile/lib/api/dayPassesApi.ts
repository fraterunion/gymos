import { apiRequest } from '@/lib/api/client';

export type DayPassStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REFUNDED';

export type DayPassDto = {
  id: string;
  /** UTC ISO string — use calendarDayKeyInZone(validForDate, timeZone) to display the studio-local date. */
  validForDate: string;
  status: DayPassStatus;
  priceCents: number;
  currency: string;
  createdAt: string;
};

export type DayPassPaymentSheetDto = {
  dayPassId: string;
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

export async function fetchDayPassCatalog(studioId: string): Promise<DayPassCatalogDto> {
  return apiRequest<DayPassCatalogDto>(`/studios/${studioId}/day-pass/catalog`, { method: 'GET' });
}

export async function fetchPublicDayPassCatalog(slug: string): Promise<DayPassCatalogDto> {
  return apiRequest<DayPassCatalogDto>(`/public/studios/${slug}/day-pass`, { method: 'GET' });
}

export async function fetchMyDayPasses(studioId: string): Promise<DayPassDto[]> {
  return apiRequest<DayPassDto[]>(`/studios/${studioId}/day-passes/me`, { method: 'GET' });
}

/**
 * Starts (or resumes) the purchase of today's Day Pass. The SERVER decides which calendar day
 * "today" is in the studio timezone, so the device clock and timezone never pick the date.
 * A retry after an abandoned or declined PaymentSheet returns the same attempt (same
 * `dayPassId`) with a fresh or re-presentable client secret — it is never a duplicate purchase.
 */
export async function createDayPassPaymentSheet(
  studioId: string,
  validForDate?: string,
): Promise<DayPassPaymentSheetDto> {
  return apiRequest<DayPassPaymentSheetDto>(`/studios/${studioId}/day-passes/payment-sheet`, {
    method: 'POST',
    body: JSON.stringify(validForDate ? { validForDate } : {}),
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
