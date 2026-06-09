-- CreateIndex
CREATE INDEX "attendances_studio_id_user_id_idx" ON "attendances"("studio_id", "user_id");

-- CreateIndex
CREATE INDEX "attendances_studio_id_user_id_checked_in_at_idx" ON "attendances"("studio_id", "user_id", "checked_in_at");
