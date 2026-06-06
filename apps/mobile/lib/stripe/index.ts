/**
 * Default entry for SSR / Node static render (no platform suffix).
 * Must not import @stripe/stripe-react-native — use index.native.ts on device.
 */
export { StripeProvider, initStripe, useStripe } from './stub';
