-- Open Gym: Full Access is unrestricted, not 11:00-22:00.
--
-- 20260822200000_open_gym_facility_access gave ARES "Full Access" an 11:00-22:00 Open Gym
-- window. That was wrong. The plan is sold as "Sin restricciones de horario", so any window at
-- all contradicts what the member bought and lets the door refuse someone at 22:05 who has paid
-- precisely to not be refused. A correction is issued as a new migration rather than by editing
-- the original, because that migration is already applied: rewriting its file would change its
-- checksum, break `prisma migrate deploy`, and still leave the bad row in place.
--
-- Unrestricted access is the ABSENCE of a window (open_gym_access = true, both bounds NULL),
-- never a cosmetic 00:00-23:59. A real range is something a member can be refused by, and "no
-- policy" must not be stored as though it were one.
--
-- The pairing CHECK constraint already permits access=true with both bounds NULL, so no
-- constraint change is required.
--
-- Idempotent, and scoped by studio slug AND plan name: any database without an 'ares-fitness'
-- studio carrying a 'Full Access' plan is left untouched. Basic Access (11:00-22:00), the Open
-- Gym plan (11:00-17:00), Pro and Booty Lab are deliberately not referenced here and keep the
-- values the previous migration set.
UPDATE "membership_plans" mp
SET "open_gym_access"       = TRUE,
    "open_gym_window_start" = NULL,
    "open_gym_window_end"   = NULL
WHERE mp."name" = 'Full Access'
  AND mp."deleted_at" IS NULL
  AND mp."studio_id" IN (
    SELECT s."id"
    FROM "studios" s
    WHERE s."slug" = 'ares-fitness'
      AND s."deleted_at" IS NULL
  );
