-- Phase 18 — Expo EAS build webhook idempotency + lookup index
CREATE TABLE "expo_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "expo_build_id" TEXT NOT NULL,
    "processed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expo_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "expo_webhook_deliveries_delivery_key_key" ON "expo_webhook_deliveries"("delivery_key");
CREATE INDEX "expo_webhook_deliveries_expo_build_id_idx" ON "expo_webhook_deliveries"("expo_build_id");
CREATE INDEX "expo_webhook_deliveries_created_at_idx" ON "expo_webhook_deliveries"("created_at");

CREATE INDEX "build_jobs_expo_build_id_idx" ON "build_jobs"("expo_build_id");
