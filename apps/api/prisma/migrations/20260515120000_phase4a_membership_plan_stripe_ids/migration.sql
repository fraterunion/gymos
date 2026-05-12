-- Phase 4A: Stripe product/price ids on membership plans (direct billing, no Connect).
ALTER TABLE "membership_plans" ADD COLUMN "stripe_product_id" TEXT;
ALTER TABLE "membership_plans" ADD COLUMN "stripe_price_id" TEXT;
