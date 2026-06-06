import type { ReactNode } from 'react';

type StripeProviderProps = {
  publishableKey: string;
  children: ReactNode;
};

type StripeError = {
  code: string;
  message: string;
};

type PaymentSheetResult = {
  error?: StripeError;
};

type InitPaymentSheetParams = {
  merchantDisplayName?: string;
  paymentIntentClientSecret?: string;
  customerId?: string;
  customerEphemeralKeySecret?: string;
  allowsDelayedPaymentMethods?: boolean;
  returnURL?: string;
};

export function StripeProvider({ children }: StripeProviderProps) {
  return <>{children}</>;
}

export async function initStripe(_params: { publishableKey: string }): Promise<void> {
  return;
}

const WEB_PAYMENT_ERROR: StripeError = {
  code: 'WEB_UNAVAILABLE',
  message: 'Day Pass payments are only available in the mobile app.',
};

export function useStripe() {
  return {
    initPaymentSheet: async (_params: InitPaymentSheetParams): Promise<PaymentSheetResult> => ({
      error: undefined,
    }),
    presentPaymentSheet: async (): Promise<PaymentSheetResult> => ({
      error: WEB_PAYMENT_ERROR,
    }),
  };
}
