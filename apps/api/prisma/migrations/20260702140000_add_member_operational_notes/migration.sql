-- Internal staff operational notes on members (not member-facing).

CREATE TABLE "member_operational_notes" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "member_user_id" TEXT NOT NULL,
    "author_user_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_operational_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "member_operational_notes_studio_id_member_user_id_idx"
    ON "member_operational_notes"("studio_id", "member_user_id");

ALTER TABLE "member_operational_notes"
    ADD CONSTRAINT "member_operational_notes_studio_id_fkey"
    FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_operational_notes"
    ADD CONSTRAINT "member_operational_notes_member_user_id_fkey"
    FOREIGN KEY ("member_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_operational_notes"
    ADD CONSTRAINT "member_operational_notes_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
