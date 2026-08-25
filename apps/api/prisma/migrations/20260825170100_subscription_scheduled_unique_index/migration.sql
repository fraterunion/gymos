-- At most one pending scheduled successor per member per studio.
CREATE UNIQUE INDEX "subscriptions_one_scheduled_per_user_per_studio_idx"
ON "subscriptions" ("studio_id", "user_id")
WHERE "status" = 'SCHEDULED'::"SubscriptionStatus";
