-- Studio-scoped flag to keep App Review / internal accounts operational
-- while excluding their people/activity metrics from owner-facing Analytics.

ALTER TABLE "studio_memberships"
ADD COLUMN "exclude_from_analytics" BOOLEAN NOT NULL DEFAULT false;
