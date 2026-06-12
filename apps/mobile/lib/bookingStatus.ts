export type BookingStatusVariant = 'confirmed' | 'checkedIn' | 'cancelled';

export type BookingStatusPillConfig = {
  label: string;
  variant: BookingStatusVariant;
};

const VARIANT_COLORS: Record<BookingStatusVariant, { text: string; bg: string }> = {
  confirmed: { text: '#4ADE80', bg: 'rgba(74,222,128,0.14)' },
  checkedIn: { text: '#FFFFFF', bg: 'rgba(255,255,255,0.12)' },
  cancelled: { text: '#F87171', bg: 'rgba(248,113,113,0.14)' },
};

export function bookingStatusPill(status: string): BookingStatusPillConfig {
  switch (status) {
    case 'CANCELLED':
      return { label: 'Cancelled', variant: 'cancelled' };
    case 'COMPLETED':
      return { label: 'Checked In', variant: 'checkedIn' };
    default:
      return { label: 'Confirmed', variant: 'confirmed' };
  }
}

export function bookingStatusColors(variant: BookingStatusVariant) {
  return VARIANT_COLORS[variant];
}
