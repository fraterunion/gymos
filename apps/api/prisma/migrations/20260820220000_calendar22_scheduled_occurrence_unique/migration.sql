-- Calendar 2.2: database-enforced canonical occurrence uniqueness.
-- Canonical key: studio_id + class_template_id + starts_at (matches Calendar 2.1 invariant #6).
-- Deploy MUST run scripts/audit-scheduled-class-duplicate-keys.ts first; migration fails if duplicates exist.

CREATE UNIQUE INDEX "scheduled_classes_studio_template_starts_unique"
  ON "scheduled_classes" ("studio_id", "class_template_id", "starts_at");
