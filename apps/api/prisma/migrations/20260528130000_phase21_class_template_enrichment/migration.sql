-- Phase 21: Class Template Enrichment
-- Adds IntensityLevel, ClassCategory enums and rich metadata fields to class_templates

CREATE TYPE "IntensityLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'EXTREME');
CREATE TYPE "ClassCategory" AS ENUM ('STRENGTH', 'HIIT', 'YOGA', 'PILATES', 'BOXING', 'RUNNING', 'RECOVERY', 'MOBILITY', 'CYCLING', 'OTHER');

ALTER TABLE "class_templates"
    ADD COLUMN "intensity_level"           "IntensityLevel",
    ADD COLUMN "category"                  "ClassCategory",
    ADD COLUMN "equipment"                 TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "hero_image_url"            TEXT,
    ADD COLUMN "thumbnail_image_url"       TEXT,
    ADD COLUMN "tags"                      TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN "is_featured"               BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "difficulty_label"          TEXT,
    ADD COLUMN "calories_estimate_min"     INTEGER,
    ADD COLUMN "calories_estimate_max"     INTEGER,
    ADD COLUMN "cancellation_window_hours" INTEGER,
    ADD COLUMN "waitlist_capacity"         INTEGER;

CREATE INDEX "class_templates_studio_id_category_idx"   ON "class_templates"("studio_id", "category");
CREATE INDEX "class_templates_studio_id_is_featured_idx" ON "class_templates"("studio_id", "is_featured");
