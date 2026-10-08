# Stripe webhook fixtures (sanitized production payloads)

Captured read-only on 2026-10-07 from `stripe_webhook_events.payload` during the Booty Lab renewal
incident audit (two paid 45-day renewals on 2026-10-02 that never produced an entitlement cycle).

These are the exact shapes the live endpoint delivers (`api_version` `2026-05-27.dahlia`, plus one
`2026-02-25.clover` event). They exist so tests exercise the REAL invoice line structure:

- the Price is at `lines.data[].pricing.price_details.price` (with `.product`);
- subscription linkage and the proration flag are under `lines.data[].parent.subscription_item_details`;
- there is NO top-level `price`, `proration`, `type` or `subscription` on a line;
- the invoice embeds neither `payment_intent` nor `payments`.

Sanitization (done before the files left the capture script):

- every customer-facing field (`customer_email`, `customer_name`, `customer_phone`, addresses,
  `account_name`, `hosted_invoice_url`, `invoice_pdf`, `number`, ...) is `[redacted]` or null;
- every Stripe id and every GymOS cuid is replaced by a stable fixture id (`sub_fx_booty_member`,
  `price_fx_booty_45d`, `prod_fx_booty`, `fx_plan_booty`, generic `*_fx0001` ...);
- request idempotency keys are replaced. Timestamps, amounts, currency and structure are real.

| File | Event | What it is |
| --- | --- | --- |
| `dahlia-invoice-paid-booty-renewal.json` | invoice.paid | The Oct 2 renewal: `subscription_cycle`, MXN 800, one 45-day line (Oct 2 16:54:40Z to Nov 16 16:54:40Z) |
| `dahlia-invoice-paid-booty-trial-bridge.json` | invoice.paid | The Aug 20 zero-value bridge onto the 45-day Price: trial line, amount 0, 43.58 days |
| `dahlia-subscription-updated-booty-renewal.json` | customer.subscription.updated | Stripe advancing the subscription to Oct 2 to Nov 16 at renewal |
| `dahlia-invoice-paid-monthly-renewal.json` | invoice.paid | A monthly (non fixed-duration) `subscription_cycle` renewal |
| `clover-invoice-paid.json` | invoice.paid | A `2026-02-25.clover` first-purchase invoice (parent also carries `license_fee_subscription_details: null`) |
| `dahlia-subscription-deleted-payment-failed.json` | customer.subscription.deleted | Stripe cancelling for non-payment (`cancellation_details.reason = payment_failed`) |
| `dahlia-invoice-payment-failed-after-delete.json` | invoice.payment_failed | The failure Stripe created 1 s BEFORE the deletion but delivered AFTER it |

Never replace these with hand-written "legacy" shapes: a hand-written `price: { id }` line is what
let the original defect pass every test.
