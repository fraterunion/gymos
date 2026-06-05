-- Phase 24: Studio-scoped CRM profile for each member
-- Stores internal notes, tags, emergency contact, goals, injuries per studio

CREATE TABLE "studio_member_profiles" (
    "id"                        TEXT        NOT NULL,
    "studio_id"                 TEXT        NOT NULL,
    "user_id"                   TEXT        NOT NULL,
    "birthdate"                 TIMESTAMPTZ,
    "emergency_contact_name"    TEXT,
    "emergency_contact_phone"   TEXT,
    "emergency_contact_relation" TEXT,
    "notes"                     TEXT,
    "tags"                      TEXT[]      NOT NULL DEFAULT '{}',
    "goals"                     TEXT,
    "injuries"                  TEXT,
    "created_at"                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at"                TIMESTAMPTZ NOT NULL,
    CONSTRAINT "studio_member_profiles_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "studio_member_profiles"
    ADD CONSTRAINT "studio_member_profiles_studio_id_fkey"
        FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE CASCADE,
    ADD CONSTRAINT "studio_member_profiles_user_id_fkey"
        FOREIGN KEY ("user_id")   REFERENCES "users"("id")   ON DELETE CASCADE;

CREATE UNIQUE INDEX "studio_member_profiles_studio_id_user_id_key"
    ON "studio_member_profiles"("studio_id", "user_id");

CREATE INDEX "studio_member_profiles_studio_id_idx"
    ON "studio_member_profiles"("studio_id");
