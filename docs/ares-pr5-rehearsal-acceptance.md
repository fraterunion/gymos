# ARES PR #5 — Isolated acceptance identities

This fixture provisions a **synthetic** studio, 3 fake membership plans (QA Basic, Pro, Full), 6 fake CASH subscriptions and three role groups: OWNER, FRONT_DESK, MEMBER. Fake plan amounts are illustrative, **not** ARES's prices. All fake emails use the reserved `.invalid` TLD, and no mail, payment, Stripe price, or existing subscription is created or changed outside the new studio.

The script `apps/api/scripts/provision-pr5-qa.mjs` is **manual only**. It does not run at deployment, in migrations, in CI or when opening the preview. It fails closed unless the runtime proves the exact dedicated Railway `release-rehearsal` environment, exact `postgres-rehearsal.railway.internal/railway` datasource and identical migration URL, Stripe TEST secret, and `EMAIL_CAMPAIGN_WORKER=0`.

## How to provision

Run from a secured command session **inside the Railway API rehearsal runtime**, without exposing the private database on the public internet. Inject three **distinct 20+ character secrets** through the rehearsal-only private environment variables `ARES_QA_OWNER_PASSWORD`, `ARES_QA_FRONT_DESK_PASSWORD`, `ARES_QA_MEMBER_PASSWORD`. Do not paste values in chats, GitHub tickets, scripts, logs or user-facing screenshots. Then explicitly opt in to this one-time action with `ARES_PR5_QA_PROVISION=I_AUTHORIZE_ISOLATED_QA_FIXTURE` and execute:

```bash
corepack pnpm --filter api exec node scripts/provision-pr5-qa.mjs
```

**Do not** repurpose this script for production, set production DB variables, bypass any guard, or execute it automatically as a predeploy command. Re-running after successful provisioning refuses to overwrite identities; cleanup should be handled through a separate reviewed, tenant-scoped database procedure after QA is signed off.

Use `owner@pr5-rehearsal.invalid` and `reception@pr5-rehearsal.invalid` to log in, with the separate credentials stored in the Railway rehearsal secret variables. Six additional synthetic MEMBER identities exist for segment and price change tests.

## Required acceptance

1. Log in to the protected branch-scoped Vercel admin preview, verify it calls the rehearsal API (not production), select `ARES PR5 QA — DATOS SINTÉTICOS`.
2. Review fake plan catalog and the six synthetic subscription price locks. Test FUTURE_ONLY, ALL_EXISTING and SELECTED **only on the synthetic plans**. Confirm no unselected lock changes, no Stripe live writes, no proration and MRR calculated from the exact locks.
3. Verify OWNER can edit plan benefits and FRONT_DESK cannot change member pricing or send campaigns. Campaign preview/draft/confirm can be tested against `.invalid` recipients only while `EMAIL_CAMPAIGN_WORKER=0`; no real mail should be sent.
4. Verify cancellation options only on separate rehearsal-created classes. Do not reuse actual ARES schedules or production members.
5. Keep Stripe TEST subscription integration and one internal Resend delivery as **separate steps** requiring additional network/provider evidence. This fixture does not prove them.
6. Record screenshots/HTTP outcomes, then clean up this QA studio with a separately reviewed procedure. No production merge without explicit later approval.

## Static guard tests

```bash
node --test apps/api/scripts/provision-pr5-qa.test.mjs
```

These tests never connect to a DB, create users or send network traffic.
