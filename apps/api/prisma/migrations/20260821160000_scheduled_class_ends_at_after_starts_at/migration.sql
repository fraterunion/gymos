-- Enforce occurrence interval integrity at the database layer.
-- Application writers already assert endsAt > startsAt; this blocks any remaining path.
ALTER TABLE "scheduled_classes"
  ADD CONSTRAINT "scheduled_classes_ends_at_after_starts_at"
  CHECK ("ends_at" > "starts_at");
