# Pilot release flow (recommended order)

Step-by-step **operator runbook** for a pilot or demo **release candidate**. Pair with [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md), [`ARES_PILOT_DEPLOYMENT_PLAN.md`](./ARES_PILOT_DEPLOYMENT_PLAN.md) (concrete first ARES deploy on Neon / Railway / Vercel / EAS + Stripe test), [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md), [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md), and [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md).

**Not in scope:** CI/CD automation, App Store / Play submission automation, push notifications.

---

## Recommended order

| Step | Action | References |
|------|--------|--------------|
| **1** | **Reset demo** (optional) | Disposable DB: `pnpm --filter api exec prisma migrate reset --force` **or** `pnpm --filter api exec prisma db seed` to refresh demo rows only ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), `pnpm --filter api demo:reset-help`). |
| **2** | **Verify seed** | Studios, users, schedules present; demo password works ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md)). |
| **3** | **Build API** | `pnpm --filter api build` from monorepo root (or host-equivalent). |
| **4** | **Run migrations** | `pnpm --filter api db:migrate:deploy` with RC `DATABASE_URL` ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)). |
| **5** | **Smoke tests** | `pnpm --filter api smoke:health` (+ optional `smoke:auth`); if Stripe test lane: `smoke:stripe-env` ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md)). |
| **6** | **Stripe webhook test** | Test mode: Dashboard “Send test event” or `stripe listen` → `POST /api/v1/stripe/webhook` returns **200** ([`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md)). Skip if demo uses **fake seed IDs only** (no real webhooks). |
| **7** | **Vercel admin verify** | Deploy or open staging admin; `NEXT_PUBLIC_API_URL` → RC API; login + today’s schedule + one class workspace ([`ADMIN.md`](./ADMIN.md)). |
| **8** | **EAS preview build** | `preview-ares` / `preview-pilates-toluca` (or base `preview`) with secrets matching RC API ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)). **Preview** = internal / pilot; **production** EAS profile = store-bound when you intentionally ship. |
| **9** | **TestFlight / internal QA** | Distribute to testers; run subset of [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md) + [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md). |
| **10** | **RC git tag (recommended)** | After internal QA and checklist are green, tag the commit per [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md) and `git push origin <tag>` so demos reference a fixed SHA. Skip only with a written reason on the RC checklist. |
| **11** | **Stakeholder walkthrough** | Use [`PILOT_DEMO_SCRIPT.md`](./PILOT_DEMO_SCRIPT.md); capture notes in [Post-demo notes](#post-demo-notes); for a full retro use [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md). |

---

## Ares Training Club example

**Full stack execution plan:** [`ARES_PILOT_DEPLOYMENT_PLAN.md`](./ARES_PILOT_DEPLOYMENT_PLAN.md) (Phase 8A — Neon, Railway, Vercel, EAS `preview-ares`, Stripe test mode, smoke commands, QA + go/no-go).

1. Seed includes **`ares-fitness`** slug; mobile **`WHITELABEL_PROFILE=ares`**, **`EXPO_PUBLIC_STUDIO_SLUG=ares-fitness`** ([`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), `env/.env.ares.example`).
2. EAS: **`preview-ares`** for internal pilot; API `CORS_ORIGIN` includes admin origin if desk is browser-based.
3. Member: `member1@ares.demo` (or test-mode member after real Checkout) for schedule → book → QR; staff: `staff@ares.demo` on admin desk.

---

## Pilates Toluca example

1. Same flow with **`pilates-toluca`** slug and **`WHITELABEL_PROFILE=pilates-toluca`** / **`preview-pilates-toluca`** ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)).
2. Second brand proves white-label split: different `APP_SCHEME`, colors, and studio data—not a second codebase.

---

## Go / no-go decision

Use before inviting external stakeholders or widening tester list.

| Criterion | Go | No-go |
|-----------|-----|--------|
| **Blockers** | None open for target flows | Any P0 unfixed |
| **RC checklist** | [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md) signed | Critical rows unchecked |
| **Stripe story** | Clear: fake-seed demo *or* test-mode lane configured | Ambiguous keys / live key risk |
| **Rollback** | Owner + prior build identified | Unknown |
| **RC tag** | Tag name recorded (or waived with reason) | Tag missing while claiming a fixed baseline |

**Decision:** Go / No-go — **Date:** ______ — **Approver:** ______

---

## Post-demo notes

Use after each pilot session (support themes, bugs, stakeholder quotes). For a **structured close-out**, copy [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md) and link the **git tag** + **EAS build id** tested.

| Date | Attendees | What worked | Issues / follow-ups |
|------|-----------|-------------|----------------------|
| | | | |

---

## Related docs

- [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md) — freeze + sign-off.
- [`ARES_PILOT_DEPLOYMENT_PLAN.md`](./ARES_PILOT_DEPLOYMENT_PLAN.md) — first real ARES pilot (stack + order + env).
- [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md) — when and how to tag RC commits.
- [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md) — pilot retro sections + go/no-go.
- [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md) — if something breaks mid-pilot.
