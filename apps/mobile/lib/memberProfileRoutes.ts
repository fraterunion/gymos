import type { Href } from 'expo-router';

export function memberProfileHref(
  userId: string,
  options?: { from?: 'sales' | 'dashboard' | 'search'; email?: string },
): Href {
  const q = new URLSearchParams();
  if (options?.from) q.set('from', options.from);
  if (options?.email) q.set('email', options.email);
  const query = q.toString();
  return `/(app)/member-profile/${userId}${query ? `?${query}` : ''}` as Href;
}

export function staffSalesHref(options?: {
  memberUserId?: string;
  initialStep?: number;
  from?: string;
}): Href {
  const q = new URLSearchParams();
  if (options?.memberUserId) q.set('memberUserId', options.memberUserId);
  if (options?.initialStep != null) q.set('initialStep', String(options.initialStep));
  if (options?.from) q.set('from', options.from);
  const query = q.toString();
  return `/(app)/staff-sales/index${query ? `?${query}` : ''}` as Href;
}
