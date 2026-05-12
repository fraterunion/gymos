# Release candidate checklist (pilot / demo)

Use this when freezing a **pilot or demo release candidate (RC)**—not full public App Store launch. Goal: **discipline**, **known-good env**, and **launch confidence** without new product scope.

**Related:** [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md) (ordered runbook), [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md) (git tag naming + when to tag), [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md) (structured pilot retro), [`PILOT_QA_CHECKLIST.md`](./PILOT_QA_CHECKLIST.md) (functional QA), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) (staging/prod cutover), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md), [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md), [`DEMO_ENVIRONMENT.md`](./DEMO_ENVIRONMENT.md), [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md), [`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md).

**Note:** [`CLIENT_LAUNCH_CHECKLIST.md`](./CLIENT_LAUNCH_CHECKLIST.md) “Phase 7 — Release” is **store listing / manual submission** focus; this RC doc is **engineering + ops** readiness before widening a pilot.

---

## 1. Feature freeze

- [ ] **No new scope** — once the **RC git tag** is pushed (if you use tags), only hotfixes on top of that baseline; defer other work ([`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md)). Backlog deferrals written down.
- [ ] **RC git tag** (recommended) — annotated tag per [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md), `git push origin <tag>`, tag name recorded in sign-off; **or** explicit waiver if you track builds by EAS id only.
- [ ] **Changelog / delta** — short list of commits or PRs since last pilot (for stakeholders and support).
- [ ] **Known bugs** — P0/P1 issues triaged; show-stoppers either fixed or explicitly listed under [Known limitations](#12-known-limitations-accepted-before-release).

---

## 2. Environment freeze

- [ ] **API** — `DATABASE_URL`, JWT, `CORS_ORIGIN`, `PORT`, Stripe vars documented and **unchanged** during RC window ([`ENV_VARS.md`](./ENV_VARS.md)).
- [ ] **Admin** — `NEXT_PUBLIC_API_URL` locked to the RC API host.
- [ ] **Mobile** — `EXPO_PUBLIC_*`, `WHITELABEL_PROFILE`, EAS secrets match the RC API and studio slugs ([`WHITE_LABEL_BUILDS.md`](./WHITE_LABEL_BUILDS.md)).
- [ ] **Secrets** — not committed; rotation plan noted if a secret was exposed during testing.

---

## 3. Branding verification

- [ ] **Public branding** — `GET /api/v1/public/studios/:slug/branding` for each pilot slug (e.g. `ares-fitness`, `pilates-toluca`): name, colors, support fields acceptable for external eyes.
- [ ] **Native shell** — `APP_DISPLAY_NAME`, icons, splash match the brand for the **preview** build under test (see `app.config.ts` + `env/.env.<profile>`).
- [ ] **Member-facing copy** — no internal codenames or env-var strings in primary error/empty paths (spot-check mobile boot + membership).

---

## 4. Stripe test verification

- [ ] **Lane chosen** — **Fake seed only** (no real Checkout) *or* **Stripe test mode** per [`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md); not mixed ambiguously for the same demo story.
- [ ] **If test mode** — `pnpm --filter api smoke:stripe-env` passes; test webhook or CLI forwarding verified once in the RC window.
- [ ] **Never `sk_live_`** on RC stack used for pilot demos.

---

## 5. Mobile build verification

- [ ] **Profile** — correct `WHITELABEL_PROFILE` and `EXPO_PUBLIC_STUDIO_SLUG` for the studio under demo.
- [ ] **EAS / local** — RC binary identified (build number, commit hash, or EAS build id); `pnpm --filter mobile config:print` matches expectations.
- [ ] **Deep links** — billing return scheme aligns with API `STRIPE_*_URL` if testing Checkout ([`MOBILE.md`](./MOBILE.md)).

---

## 6. Admin verification

- [ ] **Login** — staff account for RC studio; session survives refresh.
- [ ] **Desk** — today’s schedule, class workspace, manual check-in, QR paste path exercised once ([`ADMIN.md`](./ADMIN.md)).

---

## 7. API smoke verification

- [ ] **`smoke:health`** — `API_BASE_URL` → exit 0 ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)).
- [ ] **Optional `smoke:auth`** — pilot credentials from secrets; exit 0.
- [ ] **Logs** — startup JSON line present; no secret leakage in recent logs.

---

## 8. Database migration verification

- [ ] **Schema** — `pnpm --filter api db:migrate:deploy` run against RC database **before** or with API version stakeholders will hit; no pending migrations.
- [ ] **Backup** — snapshot or Neon branch noted before risky changes ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)).

---

## 9. TestFlight / internal track checklist

- [ ] **Build uploaded** — TestFlight (iOS) or internal testing track (Android) as applicable.
- [ ] **Testers invited** — minimal group (internal + 1–2 pilot studios).
- [ ] **Install instructions** — link or QR to install; which **profile** / API host documented.

---

## 10. Real-device checklist references

- [ ] Subset of [`REAL_DEVICE_TESTING.md`](./REAL_DEVICE_TESTING.md) completed on **physical** hardware (not only simulator), or explicitly waived with reason under limitations.

---

## 11. Rollback readiness

- [ ] **API / admin** — who can redeploy prior revision ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)).
- [ ] **Mobile** — prior TestFlight/build retained or documented as fallback.
- [ ] **Database** — migration rollback limits understood; restore path sketched if needed.

---

## 12. Known limitations accepted before release

Document anything stakeholders must **not** expect in this RC (examples: no push notifications, admin QR is paste-only, no App Store automation, seed times vs wall clock, etc.).

| Limitation | Accepted by (name) | Date |
|--------------|-------------------|------|
| | | |

---

## 13. Sign-off

| Role | Name | Date | Notes |
|------|------|------|-------|
| Engineering owner | | | |
| Pilot / studio contact | | | |
| Optional: exec sponsor | | | |

**RC identifier:** (git tag per [`RC_TAGGING_GUIDE.md`](./RC_TAGGING_GUIDE.md), e.g. `rc-pilot-ares-v1`, plus EAS build id or release name)

---

## Recommended next phase

- **Post-pilot retro** — copy [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md) for a full structured retro; keep a short log in [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md) post-demo table for quick session notes.
- **Hardening** — optional Sentry, synthetic `smoke:health` from outside the host ([`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md)).
