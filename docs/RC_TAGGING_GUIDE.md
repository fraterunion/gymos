# RC tagging guide (git)

Lightweight **git tag** discipline for pilot **release candidates (RC)**. No CI or GitHub Actions required—tags are labels on known-good commits.

**Related:** [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md), [`PILOT_RELEASE_FLOW.md`](./PILOT_RELEASE_FLOW.md), [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md), [`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md).

---

## Recommended tag naming

Use lowercase, hyphenated names that encode **audience** + **brand/studio** + **iteration**:

| Pattern | Example | When to use |
|---------|---------|-------------|
| `rc-pilot-<studio>-v<n>` | `rc-pilot-ares-v1` | First RC for ARES pilot |
| `rc-pilot-<studio>-v<n>` | `rc-pilot-pilates-v1` | First RC for Pilates Toluca pilot |
| `rc-pilot-<studio>-v<n>` | `rc-pilot-ares-v2` | Second RC after hotfixes / new freeze |
| `rc-demo-<date>` | `rc-demo-2026-05-15` | Generic internal demo, no single studio |

**Avoid** vague names like `rc1` or `test`—they do not tie to a studio or iteration when you have multiple white-label pilots.

---

## When to tag

Tag **after**:

- The commit you intend to ship to **EAS preview / TestFlight** (or deploy to staging API) is green locally: **`pnpm build`**, **`pnpm lint`**, **`pnpm typecheck`** (and any team gates you use).
- [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md) is **complete enough** for your risk tolerance (not every optional row need block a tag—document waivers).

Tag **before** (or immediately when):

- You widen the **tester list** or run a **paid stakeholder** session, so everyone can reference the **same** commit / binary lineage.

**Do not** tag **unstable** builds (failing tests, known P0 bugs, “we’ll fix it tomorrow” main). Move the fix first, then tag.

---

## What should be frozen before tagging

Align with [`RELEASE_CANDIDATE_CHECKLIST.md`](./RELEASE_CANDIDATE_CHECKLIST.md):

- **Feature freeze** — no new product scope on this line; only agreed hotfixes.
- **Env freeze** — API/admin/mobile env for this pilot documented; secrets not in git.
- **Migrations** — applied to the DB this pilot will hit (or documented plan).
- **Stripe lane** — explicit: fake-seed demo **or** test mode ([`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md)); not ambiguous.

After the tag is **pushed**, treat it as the **RC baseline**: new work continues on **`main`** (or your default branch); the tag remains on the old commit unless you retag (discouraged—prefer `v2`).

---

## Example commands

From the repo root, on the commit you want to label:

```bash
# Ensure clean tree for the commit you intend to tag (optional but recommended)
git status

# Create an annotated tag (message = short RC summary)
git tag -a rc-pilot-ares-v1 -m "RC: ARES pilot — checklist signed YYYY-MM-DD"

# List tags matching pilot RCs
git tag -l "rc-pilot-*"

# Push the tag to origin (pick ONE remote name if not `origin`)
git push origin rc-pilot-ares-v1
```

**Lightweight (non-annotated) tag** (less metadata, still works):

```bash
git tag rc-pilot-pilates-v1
git push origin rc-pilot-pilates-v1
```

---

## Rollback note

A tag does **not** roll back servers by itself. It gives you a **known commit** to redeploy or diff against ([`ROLLBACK_RUNBOOK.md`](./ROLLBACK_RUNBOOK.md)). For mobile, keep the **prior EAS build id** or TestFlight build until the new RC is validated.

---

## Hotfix naming (optional)

If you must ship a **small fix** on top of an existing RC tag without bumping the main `v` iteration:

- **Option A (preferred):** new tag `rc-pilot-ares-v2` on the hotfix commit.
- **Option B:** suffix pattern `rc-pilot-ares-v1-hotfix1` — use sparingly to avoid tag sprawl.

Never **force-move** (`-f`) a shared pilot tag to a different commit without team agreement—it breaks audit trails.

---

## Warnings

- **Do not** tag if CI (local or hosted) is red on that commit, unless you explicitly accept risk and document it on the RC checklist.
- **Do not** use **`sk_live_`** Stripe keys on the same stack you call an “RC” for internal pilot—keep test vs live boundaries clear ([`STRIPE_TEST_MODE_PILOT.md`](./STRIPE_TEST_MODE_PILOT.md)).
- Tags are **public** once pushed—no secrets in tag messages.

---

## After the pilot

Fill a retro from [`PILOT_RETRO_TEMPLATE.md`](./PILOT_RETRO_TEMPLATE.md) and link the **tag name** and **EAS build id** in that document.
