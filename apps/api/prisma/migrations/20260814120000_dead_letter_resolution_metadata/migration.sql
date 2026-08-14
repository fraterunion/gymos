-- AddColumn: dead-letter resolution metadata
-- Semantic: processed=true means handler ran to completion.
--           resolvedAt != null means operator/reconciliation confirmed no replay needed.
--           These are distinct: a conflict deliberately acknowledged by business logic
--           is processed=true; a handler that crashed stays processed=false with resolvedAt set.

ALTER TABLE "stripe_webhook_events"
  ADD COLUMN "resolved_at"     TIMESTAMP(3),
  ADD COLUMN "resolution_note" TEXT;

CREATE INDEX "stripe_webhook_events_resolved_at_idx"
  ON "stripe_webhook_events"("resolved_at");
