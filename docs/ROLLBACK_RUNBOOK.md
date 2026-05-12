# Rollback runbook

Use when a deploy **breaks production** or pilot stability. **Goal:** restore user-visible service quickly; **data** changes may be irreversible—plan before destructive migrations.

**Related:** [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md), [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md).

---

## When to stop the deploy

- **Stop immediately** if: migrations fail mid-way, API cannot start (`/health` down), **Stripe webhooks** return 5xx at high volume, or **auth** is broken for all users.
- **Pause and assess** if: elevated 5xx but `/health` ok; single feature regression; mobile-only issue (API stable).

---

## API rollback (Railway)

1. **Redeploy** previous known-good **Railway deployment** (Git commit or image tag your team pins per release).  
2. **Revert env var** changes in Railway if the incident was config-only (wrong `CORS_ORIGIN`, bad Stripe URL).  
3. **Restart** service after revert.  
4. Verify **`GET /health`**, login, and one mutating read path.

**Code rollback without DB down:** safe if new migrations were **additive** and old binary ignores new columns. If new binary **required** new columns, rolling API back **without** rolling DB forward is unsafe—prefer forward-fix or restore DB (below).

---

## Admin rollback (Vercel)

1. **Redeploy** previous production deployment from Vercel dashboard (instant rollback).  
2. Confirm `NEXT_PUBLIC_API_URL` still matches live API.  
3. Smoke login + one check-in path.

---

## Mobile rollback expectations

- **Stores:** you cannot “pull back” a binary users already installed; you ship a **new** build with fix or instruct pilots to stay on prior TestFlight version until fixed build lands.  
- **EAS:** trigger new build from last good commit with same **bundle id / package** (patch), or halt promotion of bad build to wider testers.

---

## Database migration rollback limitations

- **`prisma migrate deploy`** applies forward migrations; **automatic down** in production is **not** the default GymOS workflow.  
- **If migration was bad but no destructive data loss:** deploy **forward** migration fix (new migration) preferred.  
- **If data corrupted or schema inconsistent:** restore **Neon backup / PITR** to a point before migration (coordination: stop API traffic first to avoid split-brain writes).  
- **Never** manually edit `prisma_migrations` table without DBA discipline.

---

## Stripe webhook rollback notes

- **Misconfigured secret:** fix `STRIPE_WEBHOOK_SECRET` on API; replay failed events from Stripe Dashboard if needed.  
- **Wrong URL in Stripe:** update endpoint URL to correct API host; old URL may 404—clear duplicate endpoints.  
- **Rolling API URL:** update Stripe webhook URL **before** or **with** DNS cut; use short TTL if blue/green.

---

## When to restore a DB backup

- **Restore** (Neon PITR / snapshot) when: irreversible bad migration, accidental mass delete, or confirmed data corruption.  
- **Procedure sketch:** stop API → restore DB to new branch or overwrite per Neon docs → point `DATABASE_URL` → verify migrations state → start API → smoke test.

Document **RPO/RTO** with your Neon plan outside this repo.

---

## Communication

- [ ] Status page / Slack / email to pilots.  
- [ ] Incident note: trigger, mitigation, follow-up (postmortem optional).
