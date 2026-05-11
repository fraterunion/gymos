# Environment variables

## Principles

- **Secrets never ship to admin or mobile bundles.** Browser and Expo clients receive only public config (e.g. API base URL, publishable keys if any).
- **API** holds database URL, JWT signing secrets, Stripe secret key, and webhook signing secrets.
- **Admin** and **mobile** use `NEXT_PUBLIC_*` / Expo `EXPO_PUBLIC_*` only where values are intentionally public.

## apps/api (server)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Connection string for Postgres (or chosen DB) when persistence is added. |
| `JWT_ACCESS_SECRET` | Signs short-lived access tokens for staff and members. |
| `JWT_REFRESH_SECRET` | Signs refresh tokens; rotate independently from access. |
| `JWT_QR_SECRET` | Signs short-lived QR / check-in payloads; separate from user JWTs to limit blast radius. |
| `PORT` | HTTP listen port (default may be overridden in code). |

Future (document when implemented, not required in scaffold):

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — server only.
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
