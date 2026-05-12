import * as Linking from 'expo-linking';

/**
 * Resolves absolute return URLs for the current Expo build (scheme from app config).
 * Copy these into API env `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, and
 * `STRIPE_BILLING_PORTAL_RETURN_URL` so Stripe redirects back into the member app.
 */
export function stripeMobileReturnUrlsFromExpoLinking(): {
  success: string;
  cancel: string;
  billingPortalReturn: string;
} {
  return {
    success: Linking.createURL('billing/success'),
    cancel: Linking.createURL('billing/cancel'),
    billingPortalReturn: Linking.createURL('billing/return'),
  };
}
