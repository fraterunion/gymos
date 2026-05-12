# Environment variables

## Principles

- **Secrets never ship to admin or mobile bundles.** Browser and Expo clients receive only public config (e.g. API base URL, publishable keys if any).
- **API** holds database URL, JWT signing secrets, Stripe secret key, and webhook signing secrets.
- **Admin** and **mobile** use `NEXT_PUBLIC_*` / Expo `EXPO_PUBLIC_*` only where values are intentionally public.

## apps/api (server)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection URL for Prisma (`apps/api`). Required; the API fails fast at startup if unset. |
| `JWT_SECRET` | Signs access JWTs (Phase 1B). Required; the API fails fast at startup if unset. |
| `JWT_QR_SECRET` | Signs short-lived QR / check-in JWTs; separate from user access tokens. Required. |
| `JWT_ACCESS_TTL` | Access token lifetime (e.g. `15m`). Parsed in `apps/api` for Nest `JwtModule`. |
| `JWT_REFRESH_TTL_DAYS` | Refresh token row lifetime (opaque tokens stored hashed in DB; rotation + reuse detection). |
| `CORS_ORIGIN` | Comma-separated allowed browser origins for the API (explicit CORS in `main.ts`). |
| `BCRYPT_ROUNDS` | Cost factor for password hashing (integer; validated in `validateEnv`). |
| `PORT` | HTTP listen port (from config; default in `.env.example` is `3000`). |
| `STRIPE_SECRET_KEY` | Stripe **secret** API key (server only; test vs live mode per key prefix). Required in **production**. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /api/v1/stripe/webhook` (`whsec_…`). Required in **production**. |
| `STRIPE_SUCCESS_URL` | Absolute URL Stripe Checkout redirects to after successful payment. Required in **production**. |
| `STRIPE_CANCEL_URL` | Absolute URL Checkout redirects to when the user cancels. Required in **production**. |
| `STRIPE_BILLING_PORTAL_RETURN_URL` | Absolute URL Stripe Billing Portal returns to after the customer exits. Required in **production**. |

Non-production: `apps/api` `validateEnv` supplies safe **development defaults** when these are unset so local and CI boot without real Stripe keys; replace with your Dashboard keys and real URLs before charging customers.

Future (document when implemented):

- `REDIS_URL` — if caching or rate limits require it.

See `apps/api/.env.example` for the minimal placeholder set checked into the repo.

## apps/admin (Next.js)

Expected patterns once auth and API URL exist:

- `NEXT_PUBLIC_API_URL` — Base URL for browser calls to `apps/api`.
- Server-side only vars for session encryption or OAuth client secrets (never `NEXT_PUBLIC_*`).

## apps/mobile (Expo)

Expected patterns:

- `EXPO_PUBLIC_API_URL` — Base URL for native client.

## Local development

- Copy `apps/api/.env.example` to `.env` (gitignored) and fill placeholders locally.
- Do not commit real secrets. CI should inject secrets from a vault or hosted secrets store.
