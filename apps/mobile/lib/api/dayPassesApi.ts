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

export async function createDayPassPaymentSheet(
  studioId: string,
  validForDate: string,
): Promise<DayPassPaymentSheetDto> {
  return apiRequest<DayPassPaymentSheetDto>(`/studios/${studioId}/day-passes/payment-sheet`, {
    method: 'POST',
    body: JSON.stringify({ validForDate }),
  });
}
