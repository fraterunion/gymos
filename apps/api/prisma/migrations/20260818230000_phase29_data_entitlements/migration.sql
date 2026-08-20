-- Phase 29 data mutations — deny-by-default entitlement
--
-- REQUIRES Migration 20260818220000_phase29_deny_by_default to be applied first.
-- Executed within a single Prisma-managed transaction (PostgreSQL).
-- Zero Stripe mutations (cancelAtPeriodEnd requires separate approval + tooling).
--
-- ARES studio:     cmp33m0gp0000qomlj9p42ia5  (Ares Training Club)
-- Affects:         Full Access (23 subs), Basic (4), Pro (4), Open Gym (1), Booty Lab (3)
-- Does not touch:  Elite (inactive, 0 subs), Hyrox plan (inactive), Pilates Toluca plans
--
-- ─────────────────────────────────────────────────────────────────────────────

-- This migration contains an ARES-specific data backfill. Fresh databases do
-- not contain that tenant, so replay must safely skip the backfill instead of
-- inventing production seed data or violating foreign keys.
DO $phase29$
BEGIN
IF EXISTS (
  SELECT 1 FROM "studios" WHERE "id" = 'cmp33m0gp0000qomlj9p42ia5'
) THEN

-- ── B1: Booty Lab plan — set 45-day entitlement window ──────────────────────
-- all_classes_access already = false; Booty Lab → Booty Lab row already exists.
UPDATE "membership_plans"
SET "entitlement_days" = 45
WHERE "id" = 'cmsy7ns48002fqm1xda3z0xd7';

-- ── B2: Create Open Gym class template → link to Open Gym plan + Full Access ─
-- Open Gym is facility access (is_open_gym_slot=true), not a coached group class.
-- Enforced: 10:00–17:00 studio-local time in booking layer.
-- Full Access commercially includes Open Gym (explicit entitlement, not blanket).
-- equipment and tags are TEXT[] NOT NULL, empty array for facility/open access.
-- studio_id is NOT NULL on membership_plan_class_access — all ARES = cmp33m0gp0000qomlj9p42ia5
WITH new_open_gym_tpl AS (
  INSERT INTO "class_templates" (
    "id",
    "studio_id",
    "name",
    "description",
    "duration_minutes",
    "default_capacity",
    "color",
    "category",
    "intensity_level",
    "is_featured",
    "is_open_gym_slot",
    "access_window_start",
    "access_window_end",
    "equipment",
    "tags",
    "created_at",
    "updated_at"
  )
  VALUES (
    gen_random_uuid(),
    'cmp33m0gp0000qomlj9p42ia5',
    'Open Gym',
    'Acceso libre al gimnasio · 10:00 a.m. – 5:00 p.m. Sin clase grupal, sin entrenador.',
    420,
    100,
    '#64748b',
    NULL,
    NULL,
    FALSE,
    TRUE,
    '10:00',
    '17:00',
    ARRAY[]::TEXT[],
    ARRAY[]::TEXT[],
    NOW(),
    NOW()
  )
  RETURNING "id"
),
link_open_gym_plan AS (
  -- Open Gym plan members can book Open Gym slot only
  INSERT INTO "membership_plan_class_access" ("id", "studio_id", "membership_plan_id", "class_template_id", "created_at")
  SELECT gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmr3z8ml30015m60rnzivemyf', "id", NOW()
  FROM new_open_gym_tpl
  RETURNING "class_template_id"
)
-- Full Access members also get Open Gym access (commercial package includes it)
INSERT INTO "membership_plan_class_access" ("id", "studio_id", "membership_plan_id", "class_template_id", "created_at")
SELECT gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', "class_template_id", NOW()
FROM link_open_gym_plan;

-- ── B3: Soft-delete duplicate HYROX template ────────────────────────────────
-- "HYROX" (HIIT category, id=cmsyzt8pw003frr1y2nvnowmi, created 2026-08-18):
--   zero scheduled classes, zero bookings, zero history — accidental duplicate.
-- Canonical template preserved: "Hyrox" (HYROX category, id=cmq1y1t7z001densw5h66vt4x).
UPDATE "class_templates"
SET "deleted_at" = NOW()
WHERE "id" = 'cmsyzt8pw003frr1y2nvnowmi';

-- ── B4: Set all_classes_access = false ──────────────────────────────────────
-- Atomic with B5 (same Prisma transaction). No window where plans have
-- allClassesAccess=false but no explicit template rows.
UPDATE "membership_plans"
SET "all_classes_access" = FALSE
WHERE "id" IN (
  'cmq1y1snv000vensw5atqx03l',  -- Full Access   (23 active subscribers)
  'cmq1y1sqe000xenswkzsfwq28',  -- Basic Access  ( 4 active subscribers)
  'cmqzn1r95003zqo0rh16v6nbf',  -- Pro           ( 4 active subscribers)
  'cmr3z8ml30015m60rnzivemyf'   -- Open Gym      ( 1 active subscriber)
);
-- Excluded: Booty Lab (already false), Elite/Hyrox plan (inactive), Pilates Toluca plans

-- ── B5: Explicit template allowlist — Full Access, Basic Access, Pro ─────────
-- Normal ARES group classes: Calirox, Full Body, Hyrox (canonical only),
-- Legs+HIIT, Legs Strength, Street Bars, Upperbody.
-- Open Gym template for Full Access was already inserted in B2 above.
-- Booty Lab → Booty Lab row already exists from Phase 28.
-- Basic and Pro differ from Full Access in credit quantity only, not class list.
-- studio_id = 'cmp33m0gp0000qomlj9p42ia5' (ARES) for all rows.
INSERT INTO "membership_plan_class_access" ("id", "studio_id", "membership_plan_id", "class_template_id", "created_at")
VALUES
  -- ── Full Access ────────────────────────────────────────────────────────────
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmq1y1t63001benswj4vgkd33', NOW()),  -- Calirox
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmq1y1t2k0017enswkq7a3vz7', NOW()),  -- Full Body
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmq1y1t7z001densw5h66vt4x', NOW()),  -- Hyrox (canonical)
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmqzmmdlg003tqo0rl3o0qsz6', NOW()),  -- Legs + HIIT
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmq1y1t470019ensw4oc3mm08', NOW()),  -- Legs Strength
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmq1y1t9t001fensw22vgsfn2', NOW()),  -- Street Bars
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1snv000vensw5atqx03l', 'cmr0cjesi00039k8qxolh3lm8', NOW()),  -- Upperbody

  -- ── Basic Access ───────────────────────────────────────────────────────────
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmq1y1t63001benswj4vgkd33', NOW()),  -- Calirox
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmq1y1t2k0017enswkq7a3vz7', NOW()),  -- Full Body
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmq1y1t7z001densw5h66vt4x', NOW()),  -- Hyrox (canonical)
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmqzmmdlg003tqo0rl3o0qsz6', NOW()),  -- Legs + HIIT
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmq1y1t470019ensw4oc3mm08', NOW()),  -- Legs Strength
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmq1y1t9t001fensw22vgsfn2', NOW()),  -- Street Bars
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1sqe000xenswkzsfwq28', 'cmr0cjesi00039k8qxolh3lm8', NOW()),  -- Upperbody

  -- ── Pro ───────────────────────────────────────────────────────────────────
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmq1y1t63001benswj4vgkd33', NOW()),  -- Calirox
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmq1y1t2k0017enswkq7a3vz7', NOW()),  -- Full Body
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmq1y1t7z001densw5h66vt4x', NOW()),  -- Hyrox (canonical)
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmqzmmdlg003tqo0rl3o0qsz6', NOW()),  -- Legs + HIIT
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmq1y1t470019ensw4oc3mm08', NOW()),  -- Legs Strength
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmq1y1t9t001fensw22vgsfn2', NOW()),  -- Street Bars
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzn1r95003zqo0rh16v6nbf', 'cmr0cjesi00039k8qxolh3lm8', NOW());  -- Upperbody

-- ── B6: Set entitlement_ends_at on Booty Lab subscriptions ──────────────────
-- Aug 18 + 45 days = Oct 2, 2026. GymOS-controlled; Stripe billing is separate.
-- Stripe cancelAtPeriodEnd requires separate approval and must be set via API.
UPDATE "subscriptions"
SET "entitlement_ends_at" = TIMESTAMPTZ '2026-10-02 00:00:00 UTC'
WHERE "id" IN (
  'cmsywkujs0009rr1yyx14cm28',  -- Maky Davila    (Stripe: sub_1U5qHfGuUoCXNORE3oubMm5o)
  'cmsyxnrwb000wrr1yowl06lby',  -- Ingrid Andrade (Stripe: sub_1U5qkxGuUoCXNOREzBP7luaq)
  'cmsyztox5003nrr1yn21w18da'   -- Karla Serrano  (Stripe: sub_1U5rhaGuUoCXNORENiOIGqCk)
);

-- ── B7: Day Pass explicit class template allowlist ───────────────────────────
-- Only the 7 normal ARES group classes.
-- Booty Lab excluded: exclusive product, Day Pass cannot grant access.
-- Open Gym excluded: facility access benefit, not Day Pass eligible.
INSERT INTO "day_pass_class_access" ("id", "studio_id", "class_template_id", "created_at")
VALUES
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1t63001benswj4vgkd33', NOW()),  -- Calirox
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1t2k0017enswkq7a3vz7', NOW()),  -- Full Body
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1t7z001densw5h66vt4x', NOW()),  -- Hyrox (canonical)
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmqzmmdlg003tqo0rl3o0qsz6', NOW()),  -- Legs + HIIT
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1t470019ensw4oc3mm08', NOW()),  -- Legs Strength
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmq1y1t9t001fensw22vgsfn2', NOW()),  -- Street Bars
  (gen_random_uuid(), 'cmp33m0gp0000qomlj9p42ia5', 'cmr0cjesi00039k8qxolh3lm8', NOW());  -- Upperbody

END IF;
END
$phase29$;
