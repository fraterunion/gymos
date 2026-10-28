-- Additive: per-subscription price lock, explicit price-change ledger, and
-- studio-scoped email campaigns. Does not rewrite entitlements, periods, or
-- Stripe subscription ids. Existing rows are backfilled from the latest
-- captured succeeded payment, otherwise the current catalog price, so a later
-- catalog edit does not silently change what those members are charged.
-- Backdated paid_at reflects the DATE THE PAYMENT WAS RECEIVED, not the order
-- captured in GymOS. Use created_at when selecting the latest known transaction.
-- One-off cash overrides can differ from a recurring member price; review a
-- production snapshot of recurring Stripe and CASH amounts before deployment.
--
-- MERGING TO MAIN WILL APPLY THIS MIGRATION TO PRODUCTION.

CREATE TYPE "MembershipPriceChangeScope" AS ENUM ('ALL_EXISTING', 'FUTURE_ONLY', 'SELECTED');
CREATE TYPE "MembershipPriceChangeStatus" AS ENUM ('APPLYING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "MembershipPriceChangeItemStatus" AS ENUM ('PENDING', 'APPLYING', 'APPLIED', 'FAILED', 'SKIPPED');
CREATE TYPE "EmailCampaignStatus" AS ENUM ('DRAFT', 'SENDING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "EmailRecipientStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED', 'SUPPRESSED');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('UNSUBSCRIBE', 'BOUNCE', 'COMPLAINT', 'MANUAL');

ALTER TABLE "subscriptions" ADD COLUMN "price_cents" INTEGER;

UPDATE "subscriptions" s
SET "price_cents" = COALESCE(
  (
    SELECT p.amount_cents
    FROM "payments" p
    WHERE p.subscription_id = s.id
      AND p.status = 'SUCCEEDED'
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT 1
  ),
  (
    SELECT mp.price_cents
    FROM "membership_plans" mp
    WHERE mp.id = s.membership_plan_id
  )
)
WHERE s.price_cents IS NULL;

CREATE TABLE "membership_price_changes" (
  "id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "membership_plan_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "scope" "MembershipPriceChangeScope" NOT NULL,
  "old_price_cents" INTEGER NOT NULL,
  "new_price_cents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "previous_stripe_price_id" TEXT,
  "new_stripe_price_id" TEXT,
  "status" "MembershipPriceChangeStatus" NOT NULL DEFAULT 'APPLYING',
  "idempotency_key" TEXT NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "membership_price_changes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "membership_price_change_items" (
  "id" TEXT NOT NULL,
  "price_change_id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source" "SubscriptionSource" NOT NULL,
  "apply_new_price" BOOLEAN NOT NULL,
  "old_price_cents" INTEGER NOT NULL,
  "new_price_cents" INTEGER NOT NULL,
  "previous_stripe_price_id" TEXT,
  "applied_stripe_price_id" TEXT,
  "status" "MembershipPriceChangeItemStatus" NOT NULL DEFAULT 'PENDING',
  "error" TEXT,
  "applied_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_price_change_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_suppressions" (
  "id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_campaigns" (
  "id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body_text" TEXT NOT NULL,
  "status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "filters" JSONB NOT NULL DEFAULT '{}',
  "include_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "exclude_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "all_members" BOOLEAN NOT NULL DEFAULT false,
  "idempotency_key" TEXT NOT NULL,
  "confirmed_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "recipient_count" INTEGER NOT NULL DEFAULT 0,
  "sent_count" INTEGER NOT NULL DEFAULT 0,
  "failed_count" INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "email_campaign_recipients" (
  "id" TEXT NOT NULL,
  "campaign_id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" "EmailRecipientStatus" NOT NULL DEFAULT 'PENDING',
  "provider_message_id" TEXT,
  "error" TEXT,
  "claimed_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_campaign_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "membership_price_changes_studio_id_idempotency_key_key"
  ON "membership_price_changes"("studio_id", "idempotency_key");
CREATE INDEX "membership_price_changes_studio_id_membership_plan_id_created_at_idx"
  ON "membership_price_changes"("studio_id", "membership_plan_id", "created_at");
CREATE UNIQUE INDEX "membership_price_change_items_price_change_id_subscription_id_key"
  ON "membership_price_change_items"("price_change_id", "subscription_id");
CREATE INDEX "membership_price_change_items_price_change_id_status_idx"
  ON "membership_price_change_items"("price_change_id", "status");
CREATE UNIQUE INDEX "email_suppressions_studio_id_email_key"
  ON "email_suppressions"("studio_id", "email");
CREATE UNIQUE INDEX "email_campaigns_studio_id_idempotency_key_key"
  ON "email_campaigns"("studio_id", "idempotency_key");
CREATE INDEX "email_campaigns_studio_id_created_at_idx"
  ON "email_campaigns"("studio_id", "created_at");
CREATE INDEX "email_campaigns_status_idx"
  ON "email_campaigns"("status");
CREATE UNIQUE INDEX "email_campaign_recipients_campaign_id_user_id_key"
  ON "email_campaign_recipients"("campaign_id", "user_id");
CREATE UNIQUE INDEX "email_campaign_recipients_campaign_id_email_key"
  ON "email_campaign_recipients"("campaign_id", "email");
CREATE INDEX "email_campaign_recipients_campaign_id_status_idx"
  ON "email_campaign_recipients"("campaign_id", "status");

ALTER TABLE "membership_price_changes"
  ADD CONSTRAINT "membership_price_changes_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_price_changes"
  ADD CONSTRAINT "membership_price_changes_membership_plan_id_fkey"
  FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_price_changes"
  ADD CONSTRAINT "membership_price_changes_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "membership_price_change_items"
  ADD CONSTRAINT "membership_price_change_items_price_change_id_fkey"
  FOREIGN KEY ("price_change_id") REFERENCES "membership_price_changes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_price_change_items"
  ADD CONSTRAINT "membership_price_change_items_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_suppressions"
  ADD CONSTRAINT "email_suppressions_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_campaigns"
  ADD CONSTRAINT "email_campaigns_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_campaigns"
  ADD CONSTRAINT "email_campaigns_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "email_campaign_recipients"
  ADD CONSTRAINT "email_campaign_recipients_campaign_id_fkey"
  FOREIGN KEY ("campaign_id") REFERENCES "email_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_campaign_recipients"
  ADD CONSTRAINT "email_campaign_recipients_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_campaign_recipients"
  ADD CONSTRAINT "email_campaign_recipients_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
