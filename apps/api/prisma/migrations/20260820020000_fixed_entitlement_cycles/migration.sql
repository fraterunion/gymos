CREATE TABLE "membership_entitlement_cycles" (
  "id" TEXT NOT NULL,
  "studio_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "membership_plan_id" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "credit_limit" INTEGER,
  "source" "SubscriptionSource" NOT NULL,
  "stripe_invoice_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "membership_entitlement_cycles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "membership_entitlement_cycles_valid_window" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "membership_entitlement_cycles_positive_credit_limit"
    CHECK ("credit_limit" IS NULL OR "credit_limit" > 0)
);

CREATE UNIQUE INDEX "membership_entitlement_cycles_stripe_invoice_id_key"
  ON "membership_entitlement_cycles"("stripe_invoice_id");
CREATE UNIQUE INDEX "membership_entitlement_cycles_subscription_id_starts_at_ends_at_key"
  ON "membership_entitlement_cycles"("subscription_id", "starts_at", "ends_at");
CREATE INDEX "membership_entitlement_cycles_studio_id_user_id_starts_at_ends_at_idx"
  ON "membership_entitlement_cycles"("studio_id", "user_id", "starts_at", "ends_at");
CREATE INDEX "membership_entitlement_cycles_subscription_id_starts_at_idx"
  ON "membership_entitlement_cycles"("subscription_id", "starts_at");

ALTER TABLE "membership_entitlement_cycles" ADD CONSTRAINT "membership_entitlement_cycles_studio_id_fkey"
  FOREIGN KEY ("studio_id") REFERENCES "studios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_entitlement_cycles" ADD CONSTRAINT "membership_entitlement_cycles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_entitlement_cycles" ADD CONSTRAINT "membership_entitlement_cycles_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "membership_entitlement_cycles" ADD CONSTRAINT "membership_entitlement_cycles_membership_plan_id_fkey"
  FOREIGN KEY ("membership_plan_id") REFERENCES "membership_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cycles are immutable ledger rows. The advisory lock also serializes inserts for
-- one subscription so two different invoices cannot race past the overlap check.
CREATE FUNCTION "enforce_membership_entitlement_cycle_ledger"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'membership entitlement cycles are immutable';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW."subscription_id"));
  IF EXISTS (
    SELECT 1
    FROM "membership_entitlement_cycles" existing
    WHERE existing."subscription_id" = NEW."subscription_id"
      AND tsrange(existing."starts_at", existing."ends_at", '[)')
          && tsrange(NEW."starts_at", NEW."ends_at", '[)')
  ) THEN
    RAISE EXCEPTION 'membership entitlement cycle overlaps an existing cycle';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "membership_entitlement_cycles_immutable_nonoverlap"
BEFORE INSERT OR UPDATE OR DELETE ON "membership_entitlement_cycles"
FOR EACH ROW EXECUTE FUNCTION "enforce_membership_entitlement_cycle_ledger"();

-- Preserve every existing fixed-duration entitlement exactly as sold.
INSERT INTO "membership_entitlement_cycles" (
  "id", "studio_id", "user_id", "subscription_id", "membership_plan_id",
  "starts_at", "ends_at", "credit_limit", "source", "stripe_invoice_id", "created_at"
)
SELECT
  CONCAT('backfill_', s."id"), s."studio_id", s."user_id", s."id", s."membership_plan_id",
  s."current_period_start", s."entitlement_ends_at", p."class_credits", s."source",
  CASE WHEN payment.invoice_count = 1 THEN payment.stripe_invoice_id ELSE NULL END,
  CURRENT_TIMESTAMP
FROM "subscriptions" s
JOIN "membership_plans" p ON p."id" = s."membership_plan_id"
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INTEGER AS invoice_count, MIN(pay."stripe_invoice_id") AS stripe_invoice_id
  FROM "payments" pay
  WHERE (
      pay."subscription_id" = s."id"
      OR (
        pay."subscription_id" IS NULL
        AND pay."studio_id" = s."studio_id"
        AND pay."user_id" = s."user_id"
        AND pay."membership_plan_id" = s."membership_plan_id"
      )
    )
    AND pay."status" = 'SUCCEEDED'
    AND pay."payment_method" = 'STRIPE'
    AND pay."stripe_invoice_id" IS NOT NULL
) payment ON TRUE
WHERE p."entitlement_days" IS NOT NULL
  AND s."current_period_start" IS NOT NULL
  AND s."entitlement_ends_at" IS NOT NULL
ON CONFLICT DO NOTHING;
