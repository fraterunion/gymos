# GymOS — agent operating rules

## `main` is production

Railway watches `main`. Any commit that lands there is built, deployed, and has
`prisma migrate deploy` run against the **production** Neon database automatically. There is no
separate promotion step and no manual gate in between.

So:

> **Pushing or merging to `main` IS a production release action.**

Local approval to *write* code is not approval to *release* it. Those are two different
decisions, and only the user makes the second one.

**Required sequence:**

```
commit on a feature branch
  -> validate
  -> report
  -> WAIT for explicit production release approval
  -> only then merge/push to main
```

Never push to `main` merely because the implementation is finished, reviewed, or passing CI.

### Migrations need a louder warning

Any change containing a Prisma migration must state this verbatim in its report, before any
release decision is requested:

> **MERGING TO MAIN WILL APPLY THIS MIGRATION TO PRODUCTION.**

Say it explicitly every time. Do not assume the user is holding Railway's behaviour in their
head while reviewing a diff — that assumption has already shipped one unapproved schema change.

### Migrations that are already applied

`prisma migrate deploy` stores a checksum of every migration file it runs. Once a migration is
applied to production, its file is immutable:

- Do **not** edit, amend, squash, or rewrite it. Changing a byte changes its checksum and the
  next `migrate deploy` fails, taking the deploy pipeline down with it.
- Correct it with a **new forward migration** instead. Editing the old file would not fix
  production anyway, because an applied migration is never re-run.

Before assuming a migration is unapplied, check. `railway run --service api npx prisma migrate
status` is read-only and takes seconds.

## Production access

Read-only inspection of production is fine and encouraged before a release — preflights,
`migrate status`, count queries. Anything that writes needs explicit approval, including:

- manual SQL outside an approved migration
- Stripe mutations of any kind
- WalletCredential rotation
- Apple/Google certificate changes
- fabricated attendance or bookings "for testing"

Verify with real data or a scratch database. Never seed production to prove something works.

## OTA updates

Publishing an OTA is also a release action and follows the same approval rule. Mobile JS changes
committed to `main` do **not** reach devices until an OTA is published, so the deployed API and
the bundle staff are actually running can drift apart. State that gap explicitly rather than
assuming a merged change is live.

Before publishing to ARES:

1. Confirm the API is healthy.
2. Run `pnpm --filter mobile config:verify:ares` — this walks the real Expo
   config path with `EXPO_NO_DOTENV=1` and must resolve the production API URL
   + `ares-fitness` (never localhost / `ares-qa-demo`).
3. Dry-run: `pnpm --filter mobile ota:ares`
4. Publish only with explicit approval: `pnpm --filter mobile ota:ares:publish`

Do not invent one-off `eas update` commands with missing profile flags.
