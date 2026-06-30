-- CreateEnum
CREATE TYPE "SubscriptionSource" AS ENUM ('STRIPE', 'CASH', 'MANUAL');
CREATE TYPE "PaymentMethod" AS ENUM ('STRIPE', 'CASH', 'TERMINAL');

-- AlterTable subscriptions
ALTER TABLE "subscriptions" ADD COLUMN "source" "SubscriptionSource" NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "subscriptions" ADD COLUMN "created_by_user_id" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "notes" TEXT;

UPDATE "subscriptions" SET "source" = 'MANUAL' WHERE "stripe_subscription_id" IS NULL;

-- AlterTable payments
ALTER TABLE "payments" ADD COLUMN "payment_method" "PaymentMethod" NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "payments" ADD COLUMN "recorded_by_user_id" TEXT;
ALTER TABLE "payments" ADD COLUMN "notes" TEXT;

-- CreateTable studio_sales_settings
CREATE TABLE "studio_sales_settings" (
    "studio_id" TEXT NOT NULL,
    "front_desk_can_create_member" BOOLEAN NOT NULL DEFAULT true,
    "front_desk_can_issue_checkout" BOOLEAN NOT NULL DEFAULT true,
    "front_desk_can_record_cash" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "studio_sales_settings_pkey" PRIMARY KEY ("studio_id")
);

-- CreateTable audit_logs
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "studio_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_user_id" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_studio_id_created_at_idx" ON "audit_logs"("studio_id", "created_at");
CREATE INDEX "audit_logs_studio_id_action_idx" ON "audit_logs"("studio_id", "action");
CREATE INDEX "audit_logs_target_user_id_idx" ON "audit_logs"("target_user_id");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "studio_sales_settings" ADD CONSTRAINT "studio_sales_settings_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_studio_id_fkey" FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
